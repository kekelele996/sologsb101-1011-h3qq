/**
 * 定线 store：维护水位流量关系点据、比测记录、定线参数与残差派生值。
 * 点据按（定线号 + 涨落标记）分成两支分别拟合，残差与比测偏差按所在支线计算。
 * 定线发布后留住当时的版本与比测结论，重新拟合另出新版本。
 * 供关系点据页（/ratings）与导出页（/export）共用。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import type { Rating, RatingFitResult } from '@/types/rating'
import { createEmptyRatingFilter, curveFlow, fitPowerCurve, type RatingFilterState } from '@/types/rating'
import type { RiseFall } from '@/types/section'
import { RISE_FALL_LABELS } from '@/types/section'
import type { Station } from '@/types/station'
import type { RatingVersion, VersionCompareSnapshot, VersionFitSnapshot } from '@/types/ratingVersion'
import { nextVersionNumber } from '@/types/ratingVersion'

/** 支线拟合结果：涨落标记 + 拟合参数 */
export interface BranchFit extends RatingFitResult {
  riseFall: RiseFall | null
}

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const stations = ref<Station[]>([])
  const versions = ref<RatingVersion[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号（跨页保留） */
  const activeLineNo = ref<string>('A')
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
    watchTable<RatingVersion>(() => db.ratingVersions).subscribe((rows) => {
      versions.value = rows
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 按（定线号 + 涨落标记）分组的支线拟合结果 */
  const branchFits = computed<BranchFit[]>(() => {
    const groups = new Map<string, { lineNo: string; riseFall: RiseFall | null; points: Rating[] }>()
    ratings.value.forEach((rating) => {
      const key = `${rating.lineNo}__${rating.riseFall ?? 'null'}`
      if (!groups.has(key)) {
        groups.set(key, { lineNo: rating.lineNo, riseFall: rating.riseFall, points: [] })
      }
      groups.get(key)!.points.push(rating)
    })
    return Array.from(groups.values()).map((group) => ({
      ...fitPowerCurve(
        group.points.map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
        group.lineNo,
        group.riseFall
      )
    }))
  })

  /** 当前定线号下的支线拟合结果 */
  const activeBranchFits = computed<BranchFit[]>(() =>
    branchFits.value
      .filter((fit) => fit.lineNo === activeLineNo.value)
      .sort((a, b) => {
        const order: Record<string, number> = { rising: 0, falling: 1, null: 2 }
        return (order[a.riseFall ?? 'null'] ?? 2) - (order[b.riseFall ?? 'null'] ?? 2)
      })
  )

  /** 当前定线号的拟合结果（取首个有效支线，兼容旧调用） */
  const activeFit = computed<RatingFitResult>(() => {
    const found = activeBranchFits.value.find((fit) => fit.valid) ?? activeBranchFits.value[0]
    if (found) return found
    return fitPowerCurve([], activeLineNo.value)
  })

  /** 点据 + 所在支线曲线流量 + 残差 + 判定 */
  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const branchFit = activeBranchFits.value.find((fit) => fit.riseFall === rating.riseFall)
        const predicted = branchFit?.valid ? curveFlow(branchFit, rating.stageM) : 0
        const residualPct =
          branchFit?.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        const verdict = compare?.verdict ?? (Math.abs(residualPct) > deviationLimitPct.value ? '超限' : '合格')
        return { rating, predicted, residualPct, branchFit: branchFit ?? null, verdict }
      })
  )

  /** 按筛选条件过滤后的点据 */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.verdicts.length > 0) {
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        if (!compare || !filter.value.verdicts.includes(compare.verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.verdicts.length > 0
  )

  /** 比测行：比测记录 + 点据 + 测站名，导出页与分析清单消费 */
  const compareRows = computed<CompareRow[]>(() =>
    compares.value
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? '-'
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 定线质量派生值：平均残差与合格点占比 */
  const fitQuality = computed(() => {
    const valid = branchFits.value.filter((fit) => fit.valid)
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  /** 已定线号的发布版本（按版本号倒序） */
  const versionsOfLine = (lineNo: string): RatingVersion[] =>
    versions.value
      .filter((version) => version.lineNo === lineNo)
      .sort((a, b) => b.version - a.version)

  /** 当前定线号的最新发布版本 */
  const latestVersionOfLine = (lineNo: string): RatingVersion | null => versionsOfLine(lineNo)[0] ?? null

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  async function createRating(
    payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Rating> {
    const now = Date.now()
    const row: Rating = { ...payload, id: createId('rat'), createdAt: now, updatedAt: now }
    await db.ratings.put(row)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    await db.ratings.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeRating(id: string): Promise<void> {
    await db.transaction('rw', [db.ratings, db.compares], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
    })
  }

  /**
   * 由点据生成 / 刷新比测记录：曲线流量取所在支线的拟合值，
   * 偏差超过限值自动判定超限并进入分析清单。
   */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const targetLine = lineNo ?? activeLineNo.value
    const lineRatings = ratings.value.filter((rating) => rating.lineNo === targetLine)
    if (lineRatings.length === 0) return 0

    // 按支线分组拟合
    const branchMap = new Map<string, BranchFit>()
    lineRatings.forEach((rating) => {
      const key = rating.riseFall ?? 'null'
      if (!branchMap.has(key)) {
        const points = lineRatings
          .filter((item) => (item.riseFall ?? 'null') === key)
          .map((item) => ({ stageM: item.stageM, flowM3s: item.flowM3s }))
        branchMap.set(key, { ...fitPowerCurve(points, targetLine, rating.riseFall) })
      }
    })

    const now = Date.now()
    const rows: Compare[] = lineRatings.map((rating) => {
      const branchFit = branchMap.get(rating.riseFall ?? 'null')
      const predicted = branchFit?.valid ? curveFlow(branchFit, rating.stageM) : rating.flowM3s
      const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
      const existing = compares.value.find((item) => item.ratingId === rating.id)
      return {
        id: existing?.id ?? createId('cmp'),
        ratingId: rating.id,
        measuredFlow: rating.flowM3s,
        curveFlow: predicted,
        deviationPct,
        verdict: judgeDeviation(deviationPct, deviationLimitPct.value),
        operator: existing?.operator ?? '林昭',
        comparedAt: existing?.comparedAt ?? rating.measuredAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
    })
    await db.compares.bulkPut(rows)
    return rows.length
  }

  /**
   * 发布定线：留住当前定线号下各支线的拟合成果与比测结论，
   * 生成不可变的发布版本。重新拟合后需再次发布才会刷新版本。
   */
  async function publishVersion(lineNo: string, note = ''): Promise<RatingVersion> {
    const targetLine = lineNo
    const lineRatings = ratings.value.filter((rating) => rating.lineNo === targetLine)
    if (lineRatings.length === 0) {
      throw new Error('当前定线号下没有点据，无法发布')
    }

    // 确保比测记录是最新的
    await rebuildCompares(targetLine)

    // 支线拟合快照
    const fits: VersionFitSnapshot[] = branchFits.value
      .filter((fit) => fit.lineNo === targetLine)
      .map((fit) => ({
        riseFall: fit.riseFall,
        a: fit.a,
        b: fit.b,
        h0: fit.h0,
        sampleCount: fit.sampleCount,
        meanResidualPct: fit.meanResidualPct,
        maxResidualPct: fit.maxResidualPct,
        r2: fit.r2,
        valid: fit.valid,
        message: fit.message
      }))

    // 比测记录快照
    const lineRatingIds = new Set(lineRatings.map((rating) => rating.id))
    const lineCompares = compares.value.filter((compare) => lineRatingIds.has(compare.ratingId))
    const compareSnapshots: VersionCompareSnapshot[] = lineCompares.map((compare) => {
      const rating = lineRatings.find((item) => item.id === compare.ratingId)
      return {
        ratingId: compare.ratingId,
        measureNo: rating?.measureNo ?? '',
        riseFall: rating?.riseFall ?? null,
        measuredFlow: compare.measuredFlow,
        curveFlow: compare.curveFlow,
        deviationPct: compare.deviationPct,
        verdict: compare.verdict
      }
    })

    const overLimit = compareSnapshots.filter((item) => item.verdict === '超限').length
    const total = compareSnapshots.length
    const versionNumber = nextVersionNumber(versions.value, targetLine)
    const now = Date.now()
    const row: RatingVersion = {
      id: createId('rver'),
      lineNo: targetLine,
      version: versionNumber,
      publishedAt: new Date().toISOString(),
      fits,
      compares: compareSnapshots,
      compareSummary: {
        total,
        overLimit,
        qualifyRatePct: total === 0 ? 0 : Number((((total - overLimit) / total) * 100).toFixed(1))
      },
      note: note.trim(),
      createdAt: now,
      updatedAt: now
    }
    await db.ratingVersions.put(row)
    return row
  }

  /** 删除发布版本（仅删除版本快照，不影响点据与比测记录） */
  async function removeVersion(id: string): Promise<void> {
    await db.ratingVersions.delete(id)
  }

  /** 手工登记比测记录（导出页分析清单用） */
  async function createCompare(
    payload: Omit<Compare, 'id' | 'createdAt' | 'updatedAt' | 'deviationPct' | 'verdict'> & {
      deviationPct?: number
      verdict?: Compare['verdict']
    }
  ): Promise<Compare> {
    const now = Date.now()
    const deviationPct =
      payload.deviationPct ?? calcDeviationPct(payload.measuredFlow, payload.curveFlow)
    const row: Compare = {
      ...payload,
      deviationPct,
      verdict: payload.verdict ?? judgeDeviation(deviationPct, deviationLimitPct.value),
      id: createId('cmp'),
      createdAt: now,
      updatedAt: now
    }
    await db.compares.put(row)
    return row
  }

  async function updateCompare(id: string, patch: Partial<Compare>): Promise<void> {
    await db.compares.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeCompare(id: string): Promise<void> {
    await db.compares.delete(id)
  }

  /** 涨落标记中文文案 */
  function riseFallLabel(riseFall: RiseFall | null): string {
    return riseFall ? RISE_FALL_LABELS[riseFall] : '未标记'
  }

  return {
    ratings,
    compares,
    stations,
    versions,
    ready,
    error,
    filter,
    activeLineNo,
    activeFit,
    activeBranchFits,
    deviationLimitPct,
    lineNos,
    branchFits,
    pointRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    stationNameOf,
    versionsOfLine,
    latestVersionOfLine,
    riseFallLabel,
    patchFilter,
    resetFilter,
    setActiveLine,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    rebuildCompares,
    publishVersion,
    removeVersion,
    createCompare,
    updateCompare,
    removeCompare
  }
})
