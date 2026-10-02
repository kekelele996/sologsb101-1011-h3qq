/**
 * useRatingFit：水位流量点据支线拟合、残差与定线状态管理。
 * 按（定线号 + 涨落标记）分组拟合，残差按所在支线计算。
 * 点据数据来自 ratingStore（IndexedDB 实时订阅）。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import type { Compare } from '@/types/compare'
import {
  curveFlow,
  type Rating,
  type RatingFitResult
} from '@/types/rating'
import type { RiseFall } from '@/types/section'

/** 曲线采样点（用于关系曲线绘制） */
export interface CurveSample {
  stageM: number
  flowM3s: number
}

/** 带残差的点据行 */
export interface RatingPointRow {
  rating: Rating
  stationName: string
  /** 所在支线的曲线流量 */
  curveFlowM3s: number
  /** 相对残差（%）：(实测 - 曲线) / 实测 × 100 */
  residualPct: number
  /** 所在支线拟合结果 */
  fit: RatingFitResult | null
}

export interface UseRatingFitResult {
  ratings: Ref<Rating[]>
  compares: Ref<Compare[]>
  /** 参与定线的定线号列表 */
  lineNos: ComputedRef<string[]>
  /** 当前选中定线号 */
  activeLineNo: Ref<string>
  /** 当前定线的支线拟合结果 */
  branchFits: ComputedRef<Array<RatingFitResult & { riseFall: RiseFall | null }>>
  /** 当前定线的点据（含残差，按支线） */
  pointRows: ComputedRef<RatingPointRow[]>
  /** 当前定线的曲线采样点（按支线） */
  curveSamples: ComputedRef<Array<{ riseFall: RiseFall | null; samples: CurveSample[] }>>
  /** 超限点据清单 */
  overLimitRows: ComputedRef<RatingPointRow[]>
  /** 超限点据对应的比测记录 */
  overLimitCompares: ComputedRef<Compare[]>
  setActiveLine: (lineNo: string) => void
  /** 按当前点据重算支线参数并回写 store */
  refit: () => Promise<number>
}

/**
 * 组合式函数：按（定线号 + 涨落标记）分组拟合幂函数 Q = a×(H-H0)^b，
 * 并给出逐点残差（残差按所在支线计算）。
 */
export function useRatingFit(initialLineNo = 'A'): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const { ratings, compares } = storeToRefs(ratingStore)

  const lineNos = computed<string[]>(() => ratingStore.lineNos)

  const activeLineNo = computed<string>({
    get: () => ratingStore.activeLineNo,
    set: (value) => ratingStore.setActiveLine(value)
  })

  const branchFits = computed(() => ratingStore.activeBranchFits)

  const stationNameOf = (stationId: string): string => ratingStore.stationNameOf(stationId)

  const pointRows = computed<RatingPointRow[]>(() =>
    ratingStore.pointRows.map((row) => ({
      rating: row.rating,
      stationName: stationNameOf(row.rating.stationId),
      curveFlowM3s: row.predicted,
      residualPct: row.residualPct,
      fit: row.branchFit
    }))
  )

  const curveSamples = computed<Array<{ riseFall: RiseFall | null; samples: CurveSample[] }>>(() => {
    const rows = pointRows.value
    if (rows.length === 0) return []
    const stages = rows.map((row) => row.rating.stageM)
    const min = Math.min(...stages)
    const max = Math.max(...stages)
    const step = (max - min) / 12 || 0.1
    return branchFits.value
      .filter((fit) => fit.valid)
      .map((fit) => ({
        riseFall: fit.riseFall,
        samples: Array.from({ length: 13 }, (_, index) => {
          const stageM = Number((min + step * index).toFixed(2))
          return { stageM, flowM3s: curveFlow(fit, stageM) }
        })
      }))
  })

  const overLimitRows = computed<RatingPointRow[]>(() => {
    const limit = ratingStore.deviationLimitPct
    return pointRows.value.filter((row) => Math.abs(row.residualPct) > limit)
  })

  const overLimitCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.verdict === '超限')
  )

  function setActiveLine(lineNo: string): void {
    ratingStore.setActiveLine(lineNo)
  }

  async function refit(): Promise<number> {
    return ratingStore.rebuildCompares(activeLineNo.value)
  }

  return {
    ratings,
    compares,
    lineNos,
    activeLineNo,
    branchFits,
    pointRows,
    curveSamples,
    overLimitRows,
    overLimitCompares,
    setActiveLine,
    refit
  }
}
