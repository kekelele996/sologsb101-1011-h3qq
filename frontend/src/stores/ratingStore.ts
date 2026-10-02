/**
 * 定线 store：维护水位流量关系点据、涨 / 落双支线拟合、定线版本与比测记录。
 * 已发布版本和其比测结论只封存；点据或涨落标记变化后生成新草稿，发布后才成为新版本。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare, CompareRow } from '@/types/compare'
import { DEVIATION_LIMIT_PCT } from '@/types/compare'
import type { Rating, RatingFitResult } from '@/types/rating'
import { createEmptyRatingFilter, curveFlow, type RatingFilterState } from '@/types/rating'
import type { RatingVersion, RatingVersionCompare } from '@/types/ratingVersion'
import { RATING_BRANCHES, type RatingBranch, type Section, type StageTrend } from '@/types/section'
import { branchFitLabel, isRatingBranch } from '@/utils/stageTrend'
import {
  branchPoints,
  compareIdOf,
  createRatingVersion,
  findBranchFit,
  groupCurrentRatings,
  ratingGroupKey
} from '@/utils/ratingVersion'
import type { Station } from '@/types/station'

export interface RatingPointRow {
  rating: Rating | null
  ratingId: string
  stationName: string
  stageM: number
  measuredFlow: number
  curveFlowM3s: number
  residualPct: number
  verdict: Compare['verdict']
  branch: RatingBranch
  fit: RatingFitResult
}

interface GroupKey {
  stationId: string
  lineNo: string
}

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const versions = ref<RatingVersion[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  const activeStationId = ref<string>('')
  const activeLineNo = ref<string>('A')
  const activeBranch = ref<RatingBranch>('涨水')
  const activeVersionId = ref<string | null>(null)
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
    watchTable<RatingVersion>(() => db.ratingVersions).subscribe((rows) => {
      versions.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
  }

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  const groups = computed<GroupKey[]>(() => {
    const map = new Map<string, GroupKey>()
    ratings.value.forEach((rating) => {
      map.set(ratingGroupKey(rating.stationId, rating.lineNo), {
        stationId: rating.stationId,
        lineNo: rating.lineNo
      })
    })
    return Array.from(map.values()).sort((a, b) => {
      const stationName = stationNameOf(a.stationId).localeCompare(stationNameOf(b.stationId), 'zh-CN')
      return stationName || a.lineNo.localeCompare(b.lineNo)
    })
  })

  const effectiveStationId = computed<string>(() => {
    if (activeStationId.value && groups.value.some((group) => group.stationId === activeStationId.value)) {
      return activeStationId.value
    }
    return groups.value[0]?.stationId ?? activeStationId.value
  })

  const lineNos = computed<string[]>(() => {
    const set = new Set(
      groups.value.filter((group) => group.stationId === effectiveStationId.value).map((group) => group.lineNo)
    )
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const effectiveLineNo = computed<string>(() => {
    if (lineNos.value.includes(activeLineNo.value)) return activeLineNo.value
    return lineNos.value[0] ?? activeLineNo.value
  })

  const groupVersions = computed<RatingVersion[]>(() =>
    versions.value
      .filter(
        (version) =>
          version.stationId === effectiveStationId.value && version.lineNo === effectiveLineNo.value
      )
      .sort((a, b) => b.versionNo - a.versionNo)
  )

  const draftVersion = computed<RatingVersion | null>(
    () => groupVersions.value.find((version) => version.status === 'draft') ?? null
  )

  const latestPublishedVersion = computed<RatingVersion | null>(
    () => groupVersions.value.find((version) => version.status === 'published') ?? null
  )

  const currentGroupRatings = computed<Rating[]>(() =>
    groupCurrentRatings(ratings.value, effectiveStationId.value, effectiveLineNo.value)
  )

  const pendingRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => rating.stageTrend === '待判')
  )

  const pendingGroupRatings = computed<Rating[]>(() =>
    pendingRatings.value.filter(
      (rating) => rating.stationId === effectiveStationId.value && rating.lineNo === effectiveLineNo.value
    )
  )

  /** 无历史版本时，用当前点据即时计算一版，不落库、不视为发布。 */
  const transientVersion = computed<RatingVersion | null>(() => {
    if (!effectiveStationId.value || groupVersions.value.length > 0) return null
    return createRatingVersion(currentGroupRatings.value, {
      id: 'transient-draft',
      stationId: effectiveStationId.value,
      lineNo: effectiveLineNo.value,
      versionNo: 1,
      status: 'draft',
      note: '未保存的临时拟合'
    })
  })

  const activeVersion = computed<RatingVersion | null>(() => {
    const selected = groupVersions.value.find((version) => version.id === activeVersionId.value)
    if (selected) return selected
    return draftVersion.value ?? latestPublishedVersion.value ?? transientVersion.value
  })

  const isViewingHistorical = computed<boolean>(() => {
    const current = activeVersion.value
    if (!current) return false
    if (current.status === 'draft') return false
    return Boolean(draftVersion.value) || latestPublishedVersion.value?.id !== current.id
  })

  const activeFit = computed<RatingFitResult>(() => {
    const fit = activeVersion.value?.fits.find((item) => item.branch === activeBranch.value)
    return (
      fit ?? {
        lineNo: effectiveLineNo.value,
        branch: activeBranch.value,
        a: 0,
        b: 0,
        h0: 0,
        sampleCount: 0,
        meanResidualPct: 0,
        maxResidualPct: 0,
        r2: 0,
        valid: false,
        message: `${activeBranch.value}支点据少于 3 个，无法定线`
      }
    )
  })

  function snapshotToRow(item: RatingVersionCompare, fit: RatingFitResult): RatingPointRow {
    const rating = ratings.value.find((row) => row.id === item.ratingId) ?? null
    return {
      rating,
      ratingId: item.ratingId,
      stationName: stationNameOf(rating?.stationId ?? effectiveStationId.value),
      stageM: item.stageM,
      measuredFlow: item.measuredFlow,
      curveFlowM3s: item.curveFlow,
      residualPct: -item.deviationPct,
      verdict: item.verdict,
      branch: item.branch ?? activeBranch.value,
      fit
    }
  }

  function ratingToRow(rating: Rating, fit: RatingFitResult): RatingPointRow {
    const predicted = fit.valid ? curveFlow(fit, rating.stageM) : 0
    const residualPct =
      fit.valid && rating.flowM3s > 0
        ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
        : 0
    const liveCompare = compares.value.find(
      (compare) =>
        compare.ratingId === rating.id &&
        compare.versionId === (draftVersion.value?.id ?? latestPublishedVersion.value?.id)
    )
    return {
      rating,
      ratingId: rating.id,
      stationName: stationNameOf(rating.stationId),
      stageM: rating.stageM,
      measuredFlow: rating.flowM3s,
      curveFlowM3s: predicted,
      residualPct,
      verdict: liveCompare?.verdict ?? (Math.abs(residualPct) > deviationLimitPct.value ? '超限' : '合格'),
      branch: activeBranch.value,
      fit
    }
  }

  /** 当前支线点据；查看历史版本时读封存结论，查看草稿时按当前点据实时计算。 */
  const pointRows = computed<RatingPointRow[]>(() => {
    const version = activeVersion.value
    const fit = activeFit.value
    if (!version) return []
    if (!isViewingHistorical.value) {
      return branchPoints(currentGroupRatings.value, activeBranch.value)
        .sort((a, b) => a.stageM - b.stageM)
        .map((rating) => ratingToRow(rating, fit))
    }
    return version.compares
      .filter((item) => item.branch === activeBranch.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((item) => snapshotToRow(item, fit))
  })

  /** 当前各测站 / 定线号正在使用的版本：草稿优先，否则最新发布版。 */
  const currentVersionByGroup = computed<Map<string, RatingVersion>>(() => {
    const result = new Map<string, RatingVersion>()
    versions.value.forEach((version) => {
      const key = ratingGroupKey(version.stationId, version.lineNo)
      const existing = result.get(key)
      if (version.status === 'draft' || !existing || existing.status !== 'draft') {
        result.set(key, version)
      }
    })
    return result
  })

  const compareRows = computed<CompareRow[]>(() => {
    const currentIds = new Set(Array.from(currentVersionByGroup.value.values()).map((version) => version.id))
    return compares.value
      .filter((compare) => currentIds.has(compare.versionId))
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        const version = versions.value.find((item) => item.id === compare.versionId)
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: version?.lineNo ?? rating?.lineNo ?? '-',
          branch: compare.branch,
          versionId: compare.versionId
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  })

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 逐支线的当前定线质量 */
  const fitQuality = computed(() => {
    const currentVersions = Array.from(currentVersionByGroup.value.values())
    const fits = currentVersions.flatMap((version) => version.fits)
    const valid = fits.filter((fit) => fit.valid)
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

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
      if (filter.value.branches.length > 0) {
        if (!isRatingBranch(rating.stageTrend) || !filter.value.branches.some((item) => item === rating.stageTrend)) return false
      }
      if (filter.value.verdicts.length > 0) {
        const currentVersion = currentVersionByGroup.value.get(ratingGroupKey(rating.stationId, rating.lineNo))
        const compare = compares.value.find(
          (item) => item.ratingId === rating.id && item.versionId === currentVersion?.id
        )
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
      filter.value.branches.length > 0 ||
      filter.value.verdicts.length > 0
  )

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveStation(stationId: string): void {
    activeStationId.value = stationId
    activeVersionId.value = null
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
    activeVersionId.value = null
  }

  function setActiveBranch(branch: RatingBranch): void {
    activeBranch.value = branch
  }

  function selectVersion(versionId: string | null): void {
    activeVersionId.value = versionId
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
    activeStationId.value = row.stationId
    activeLineNo.value = row.lineNo
    activeVersionId.value = null
    if (isRatingBranch(row.stageTrend)) activeBranch.value = row.stageTrend
    await rebuildGroupCompares(row.stationId, row.lineNo)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    const previous = await db.ratings.get(id)
    await db.ratings.update(id, { ...patch, updatedAt: Date.now() } as never)
    if (!previous) return
    const current = await db.ratings.get(id)
    const affectedGroups = new Set<string>([
      ratingGroupKey(previous.stationId, previous.lineNo),
      ratingGroupKey(current?.stationId ?? previous.stationId, current?.lineNo ?? previous.lineNo)
    ])
    for (const key of affectedGroups) {
      const [stationId, lineNo] = key.split(' ')
      await rebuildGroupCompares(stationId, lineNo)
    }
  }

  async function removeRating(id: string): Promise<void> {
    const previous = await db.ratings.get(id)
    await db.transaction('rw', [db.ratings, db.compares], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
    })
    if (previous) await rebuildGroupCompares(previous.stationId, previous.lineNo)
  }

  /**
   * 重算某组当前草稿的涨、落两支及比测。
   * 若该组已有发布版，不覆盖它，而是另建 / 更新更高版本号草稿。
   */
  async function rebuildGroupCompares(stationId: string, lineNo: string): Promise<RatingVersion | null> {
    const allRatings = await db.ratings.where('stationId').equals(stationId).toArray()
    const allVersions = await db.ratingVersions.where('stationId').equals(stationId).toArray()
    const groupRatings = allRatings.filter((rating) => rating.lineNo === lineNo)
    const storedVersions = allVersions.filter((version) => version.lineNo === lineNo)
    const storedCompares = await db.compares.toArray()
    if (groupRatings.length === 0) return null

    const now = Date.now()
    const sorted = storedVersions.slice().sort((a, b) => b.versionNo - a.versionNo)
    const existingDraft = sorted.find((version) => version.status === 'draft')
    const latestPublished = sorted.find((version) => version.status === 'published')
    const baseline = existingDraft ?? latestPublished
    const previousCompares = baseline?.compares ?? storedCompares
    const version = createRatingVersion(groupRatings, {
      id: existingDraft?.id ?? createId('ver'),
      stationId,
      lineNo,
      versionNo: existingDraft?.versionNo ?? (latestPublished?.versionNo ?? 0) + 1,
      status: 'draft',
      note: existingDraft?.note ?? `第 ${(latestPublished?.versionNo ?? 0) + 1} 版草稿：按涨 / 落支线重新拟合`,
      now,
      previous: previousCompares
    })

    const rows: Compare[] = version.compares.flatMap((item) => {
      if (!item.branch) return []
      return [{
        id: compareIdOf(version.id, item.ratingId),
        versionId: version.id,
        ratingId: item.ratingId,
        branch: item.branch,
        measuredFlow: item.measuredFlow,
        curveFlow: item.curveFlow,
        deviationPct: item.deviationPct,
        verdict: item.verdict,
        operator: item.operator,
        comparedAt: item.comparedAt,
        createdAt: existingDraft?.createdAt ?? now,
        updatedAt: now
      }]
    })

    await db.transaction('rw', [db.ratingVersions, db.compares], async () => {
      await db.compares.where('versionId').equals(version.id).delete()
      await db.ratingVersions.put(version)
      await db.compares.bulkPut(rows)
    })
    activeStationId.value = stationId
    activeLineNo.value = lineNo
    activeVersionId.value = version.id
    return version
  }

  /** 发布当前草稿；旧发布版转为归档，原快照和比测结论保持不变。 */
  async function publishVersion(versionId?: string): Promise<RatingVersion | null> {
    const targetId = versionId ?? draftVersion.value?.id
    if (!targetId) return null
    const draft = await db.ratingVersions.get(targetId)
    if (!draft || draft.status !== 'draft') return null
    const now = Date.now()
    await db.transaction('rw', db.ratingVersions, async () => {
      const stationVersions = await db.ratingVersions.where('stationId').equals(draft.stationId).toArray()
      const sameGroup = stationVersions.filter((version) => version.lineNo === draft.lineNo)
      for (const version of sameGroup) {
        if (version.id === draft.id) continue
        if (version.status === 'published') {
          await db.ratingVersions.update(version.id, { status: 'archived', updatedAt: now } as never)
        }
      }
      await db.ratingVersions.update(draft.id, {
        status: 'published',
        publishedAt: new Date(now).toISOString(),
        note: `发布第 ${draft.versionNo} 版：涨水 / 落水双支线定线`,
        updatedAt: now
      } as never)
    })
    activeVersionId.value = draft.id
    return (await db.ratingVersions.get(draft.id)) ?? null
  }

  /** 全部组各生成 / 更新一版草稿，供导出页显式“重新拟合并刷新”使用 */
  async function rebuildAllCompares(): Promise<number> {
    const groupKeys = Array.from(
      ratings.value.reduce((set, rating) => {
        set.add(ratingGroupKey(rating.stationId, rating.lineNo))
        return set
      }, new Set<string>())
    )
    for (const key of groupKeys) {
      const [stationId, lineNo] = key.split(' ')
      await rebuildGroupCompares(stationId, lineNo)
    }
    return groupKeys.length
  }

  /** 测次涨落标记改动后，同步来源测次号相同的点据，并重算所在支线的草稿。 */
  async function syncRatingsForSection(section: Pick<Section, 'stationId' | 'measureNo' | 'stageTrend'>): Promise<number> {
    if (section.stageTrend === '待判' || !isRatingBranch(section.stageTrend)) return 0
    const stationRatings = await db.ratings.where('stationId').equals(section.stationId).toArray()
    const targets = stationRatings.filter((rating) => rating.measureNo === section.measureNo)
    if (targets.length === 0) return 0

    const now = Date.now()
    const groups = new Set(targets.map((rating) => ratingGroupKey(rating.stationId, rating.lineNo)))
    await db.ratings.bulkPut(
      targets.map((rating) => ({ ...rating, stageTrend: section.stageTrend, updatedAt: now }))
    )
    for (const key of groups) {
      const [stationId, lineNo] = key.split(' ')
      await rebuildGroupCompares(stationId, lineNo)
    }
    return targets.length
  }

  async function setPendingRatingTrend(ratingId: string, trend: StageTrend): Promise<void> {
    await updateRating(ratingId, { stageTrend: trend })
  }

  /** 手工登记历史比测记录：仍归入明确版本，避免脱离发布结论游离 */
  async function createCompare(
    payload: Omit<Compare, 'id' | 'createdAt' | 'updatedAt' | 'deviationPct' | 'verdict'> & {
      deviationPct?: number
      verdict?: Compare['verdict']
    }
  ): Promise<Compare> {
    const now = Date.now()
    const row: Compare = {
      ...payload,
      id: createId('cmp'),
      deviationPct: payload.deviationPct ?? 0,
      verdict: payload.verdict ?? '合格',
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

  return {
    ratings,
    compares,
    versions,
    stations,
    ready,
    error,
    filter,
    activeStationId,
    activeLineNo,
    activeBranch,
    activeVersionId,
    deviationLimitPct,
    groups,
    lineNos,
    effectiveStationId,
    effectiveLineNo,
    groupVersions,
    draftVersion,
    latestPublishedVersion,
    activeVersion,
    activeFit,
    isViewingHistorical,
    pendingRatings,
    pendingGroupRatings,
    pointRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    stationNameOf,
    patchFilter,
    resetFilter,
    setActiveStation,
    setActiveLine,
    setActiveBranch,
    selectVersion,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    rebuildGroupCompares,
    rebuildAllCompares,
    publishVersion,
    syncRatingsForSection,
    setPendingRatingTrend,
    createCompare,
    updateCompare,
    removeCompare
  }
})

export { branchFitLabel, RATING_BRANCHES, findBranchFit }
