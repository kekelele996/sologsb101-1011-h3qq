/**
 * useRatingFit：水位流量点据按涨 / 落两支拟合、残差与定线状态管理。
 * 被关系点据页与导出页消费；点据数据来自 ratingStore（IndexedDB 实时订阅）。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import type { Compare } from '@/types/compare'
import { curveFlow, fitPowerCurve, type Rating, type RatingFitResult } from '@/types/rating'
import { RATING_BRANCHES, type RatingBranch } from '@/types/section'

/** 曲线采样点（用于关系曲线绘制） */
export interface CurveSample {
  stageM: number
  flowM3s: number
}

/** 带残差的点据行 */
export interface RatingPointRow {
  rating: Rating
  stationName: string
  curveFlowM3s: number
  residualPct: number
  fit: RatingFitResult
}

export interface UseRatingFitResult {
  ratings: Ref<Rating[]>
  compares: Ref<Compare[]>
  lineNos: ComputedRef<string[]>
  activeLineNo: Ref<string>
  activeBranch: Ref<RatingBranch>
  fit: ComputedRef<RatingFitResult>
  allFits: ComputedRef<RatingFitResult[]>
  pointRows: ComputedRef<RatingPointRow[]>
  curveSamples: ComputedRef<CurveSample[]>
  overLimitRows: ComputedRef<RatingPointRow[]>
  overLimitCompares: ComputedRef<Compare[]>
  setActiveLine: (lineNo: string) => void
  setActiveBranch: (branch: RatingBranch) => void
  refit: () => RatingFitResult
}

/**
 * 组合式函数：按定线号 + 涨落支线分组拟合幂函数 Q = a×(H-H0)^b，并给出逐点残差。
 */
export function useRatingFit(initialLineNo = 'A', initialBranch: RatingBranch = '涨水'): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const { ratings, compares } = storeToRefs(ratingStore)
  const activeLineNo = ref<string>(initialLineNo)
  const activeBranch = ref<RatingBranch>(initialBranch)

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    if (set.size === 0) set.add(initialLineNo)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string => ratingStore.stationNameOf(stationId)

  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.flatMap((lineNo) =>
      RATING_BRANCHES.map((branch) => {
        const points = ratings.value
          .filter((rating) => rating.lineNo === lineNo && rating.stageTrend === branch)
          .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s }))
        return fitPowerCurve(points, lineNo, branch)
      })
    )
  )

  const fit = computed<RatingFitResult>(() => {
    const found = allFits.value.find(
      (item) => item.lineNo === activeLineNo.value && item.branch === activeBranch.value
    )
    if (found) return found
    return fitPowerCurve([], activeLineNo.value, activeBranch.value)
  })

  const pointRows = computed<RatingPointRow[]>(() => {
    const current = fit.value
    return ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value && rating.stageTrend === activeBranch.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const predicted = current.valid ? curveFlow(current, rating.stageM) : 0
        const residualPct =
          current.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return {
          rating,
          stationName: stationNameOf(rating.stationId),
          curveFlowM3s: predicted,
          residualPct,
          fit: current
        }
      })
  })

  const curveSamples = computed<CurveSample[]>(() => {
    const current = fit.value
    const rows = pointRows.value
    if (!current.valid || rows.length === 0) return []
    const stages = rows.map((row) => row.rating.stageM)
    const min = Math.min(...stages)
    const max = Math.max(...stages)
    const step = (max - min) / 12 || 0.1
    return Array.from({ length: 13 }, (_, index) => {
      const stageM = Number((min + step * index).toFixed(2))
      return { stageM, flowM3s: curveFlow(current, stageM) }
    })
  })

  const overLimitRows = computed<RatingPointRow[]>(() => {
    const limit = ratingStore.deviationLimitPct
    return allFits.value.flatMap((item) =>
      ratings.value
        .filter((rating) => rating.lineNo === item.lineNo && rating.stageTrend === item.branch)
        .map((rating) => {
          const predicted = item.valid ? curveFlow(item, rating.stageM) : 0
          const residualPct =
            item.valid && rating.flowM3s > 0
              ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
              : 0
          return {
            rating,
            stationName: stationNameOf(rating.stationId),
            curveFlowM3s: predicted,
            residualPct,
            fit: item
          }
        })
        .filter((row) => Math.abs(row.residualPct) > limit)
    )
  })

  const overLimitCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.verdict === '超限')
  )

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setActiveBranch(branch: RatingBranch): void {
    activeBranch.value = branch
  }

  function refit(): RatingFitResult {
    const points = ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value && rating.stageTrend === activeBranch.value)
      .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s }))
    const result = fitPowerCurve(points, activeLineNo.value, activeBranch.value)
    return result
  }

  return {
    ratings,
    compares,
    lineNos,
    activeLineNo,
    activeBranch,
    fit,
    allFits,
    pointRows,
    curveSamples,
    overLimitRows,
    overLimitCompares,
    setActiveLine,
    setActiveBranch,
    refit
  }
}
