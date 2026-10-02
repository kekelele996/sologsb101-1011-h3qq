import type { Compare } from './compare'
import type { RatingFitResult } from './rating'
import type { RatingBranch } from './section'

/** 定线版本状态：草稿可随点据重算；发布后封存，只能另出新版 */
export type RatingVersionStatus = 'draft' | 'published' | 'archived'

/** 发布版本中封存的单支线比测结论 */
export interface RatingVersionCompare {
  ratingId: string
  stageM: number
  measuredFlow: number
  curveFlow: number
  deviationPct: number
  verdict: Compare['verdict']
  /** 点据所在支线；升级前历史结论若无法判明，可缺省，只随版本封存不参与当前清单 */
  branch?: RatingBranch
  operator: string
  comparedAt: string
}

/**
 * 定线版本：同一测站 + 同一基础定线号的一次成果。
 * 涨水、落水两支的拟合参数与当时比测结论同时封存。
 */
export interface RatingVersion {
  id: string
  stationId: string
  lineNo: string
  versionNo: number
  status: RatingVersionStatus
  fits: RatingFitResult[]
  compares: RatingVersionCompare[]
  publishedAt: string | null
  note: string
  createdAt: number
  updatedAt: number
}
