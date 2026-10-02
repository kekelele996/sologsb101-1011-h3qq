/**
 * 定线版本构造工具：把某测站、某基础定线号下的点据按涨 / 落两支分别拟合，
 * 并把当时各点的比测结论写入版本快照。工具层不直接访问 IndexedDB。
 */
import { calcDeviationPct, judgeDeviation, type Compare } from '@/types/compare'
import { curveFlow, fitPowerCurve, type Rating, type RatingFitResult } from '@/types/rating'
import type { RatingVersion, RatingVersionCompare } from '@/types/ratingVersion'
import { RATING_BRANCHES, type RatingBranch } from '@/types/section'
import { branchFitKey, isRatingBranch } from './stageTrend'

type RatingInput = Pick<Rating, 'id' | 'stationId' | 'stageM' | 'flowM3s' | 'lineNo' | 'stageTrend' | 'measuredAt'>

export function ratingGroupKey(stationId: string, lineNo: string): string {
  return `${stationId} ${lineNo}`
}

export function compareIdOf(versionId: string, ratingId: string): string {
  return `cmp_${versionId}_${ratingId}`
}

export function branchPoints<T extends RatingInput>(ratings: T[], branch: RatingBranch): T[] {
  return ratings.filter((rating) => rating.stageTrend === branch)
}

function makeCompare(
  rating: RatingInput,
  branch: RatingBranch,
  fit: RatingFitResult,
  previous: Compare | RatingVersionCompare | undefined,
  now: number
): RatingVersionCompare {
  const predicted = fit.valid ? curveFlow(fit, rating.stageM) : rating.flowM3s
  const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
  return {
    ratingId: rating.id,
    stageM: rating.stageM,
    measuredFlow: rating.flowM3s,
    curveFlow: predicted,
    deviationPct,
    verdict: judgeDeviation(deviationPct),
    branch,
    operator: previous?.operator ?? '林昭',
    comparedAt: previous?.comparedAt ?? rating.measuredAt ?? new Date(now).toISOString()
  }
}

/** 重新计算一组点据的涨、落两支拟合结果；待判点不进入拟合 */
export function fitBranchRatings<T extends RatingInput>(ratings: T[], lineNo: string): RatingFitResult[] {
  return RATING_BRANCHES.map((branch) =>
    fitPowerCurve(
      branchPoints(ratings, branch).map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
      lineNo,
      branch
    )
  )
}

export function buildVersionCompares<T extends RatingInput>(
  ratings: T[],
  fits: RatingFitResult[],
  previous: Array<Compare | RatingVersionCompare>,
  now: number
): RatingVersionCompare[] {
  const previousMap = new Map(previous.map((item) => [item.ratingId, item]))
  return RATING_BRANCHES.flatMap((branch) => {
    const fit = fits.find((item) => item.branch === branch)
    if (!fit) return []
    return branchPoints(ratings, branch).map((rating) =>
      makeCompare(rating, branch, fit, previousMap.get(rating.id), now)
    )
  })
}

export interface CreateVersionOptions {
  id: string
  stationId: string
  lineNo: string
  versionNo: number
  status?: RatingVersion['status']
  note?: string
  now?: number
  previous?: Array<Compare | RatingVersionCompare>
}

/** 由当前点据生成一版涨 / 落双支线拟合和比测快照 */
export function createRatingVersion<T extends RatingInput>(
  ratings: T[],
  options: CreateVersionOptions
): RatingVersion {
  const now = options.now ?? Date.now()
  const fits = fitBranchRatings(ratings, options.lineNo)
  const compares = buildVersionCompares(ratings, fits, options.previous ?? [], now)
  const status = options.status ?? 'draft'
  return {
    id: options.id,
    stationId: options.stationId,
    lineNo: options.lineNo,
    versionNo: options.versionNo,
    status,
    fits,
    compares,
    publishedAt: status === 'published' ? new Date(now).toISOString() : null,
    note: options.note ?? (status === 'published' ? `发布第 ${options.versionNo} 版` : `第 ${options.versionNo} 版草稿`),
    createdAt: now,
    updatedAt: now
  }
}

/** 供表格、曲线按支线查拟合结果 */
export function findBranchFit(fits: RatingFitResult[], branch: RatingBranch): RatingFitResult | undefined {
  return fits.find((fit) => fit.branch === branch)
}

export function groupCurrentRatings<T extends RatingInput>(
  ratings: T[],
  stationId: string,
  lineNo: string
): T[] {
  return ratings.filter(
    (rating) => rating.stationId === stationId && rating.lineNo === lineNo && isRatingBranch(rating.stageTrend)
  )
}

export { branchFitKey }
