/**
 * 定线发布版本：每次「发布」留住当时的定线成果与比测结论，
 * 已发布版本不可变，重新拟合只能另出新版本。
 */
import type { RiseFall } from './section'
import type { CompareVerdict } from './compare'

/** 发布时的单支线定线成果快照 */
export interface VersionFitSnapshot {
  /** 涨落支线：涨水 / 落水；为空表示未标记支线 */
  riseFall: RiseFall | null
  a: number
  b: number
  h0: number
  sampleCount: number
  meanResidualPct: number
  maxResidualPct: number
  r2: number
  valid: boolean
  message: string
}

/** 发布时的比测记录快照（不含 id 关联，仅留结论） */
export interface VersionCompareSnapshot {
  ratingId: string
  measureNo: string
  riseFall: RiseFall | null
  measuredFlow: number
  curveFlow: number
  deviationPct: number
  verdict: CompareVerdict
}

/** 比测结论汇总 */
export interface VersionCompareSummary {
  total: number
  overLimit: number
  qualifyRatePct: number
}

/** 定线发布版本 */
export interface RatingVersion {
  id: string
  /** 定线号 */
  lineNo: string
  /** 版本号：同一定线号内递增 */
  version: number
  /** 发布时间 */
  publishedAt: string
  /** 发布时的定线成果（按支线） */
  fits: VersionFitSnapshot[]
  /** 发布时的比测记录快照 */
  compares: VersionCompareSnapshot[]
  /** 比测结论汇总 */
  compareSummary: VersionCompareSummary
  /** 发布说明 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 生成下一个版本号：取同定线号最大版本号 +1 */
export function nextVersionNumber(versions: RatingVersion[], lineNo: string): number {
  const max = versions
    .filter((v) => v.lineNo === lineNo)
    .reduce((acc, v) => Math.max(acc, v.version), 0)
  return max + 1
}
