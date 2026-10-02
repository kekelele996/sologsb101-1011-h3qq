/**
 * 水位涨落趋势回填。
 * 按同一测站的测流时间排序，与前一个测次水位比较；首测次、平峰、缺时间等情况列为待判。
 */
import type { Rating } from '@/types/rating'
import type { RatingBranch, Section, StageTrend } from '@/types/section'

function trendByStage(previousStageM: number | undefined, stageM: number | undefined): StageTrend {
  if (typeof previousStageM !== 'number' || typeof stageM !== 'number' || !Number.isFinite(stageM)) return '待判'
  if (Math.abs(stageM - previousStageM) < 1e-9) return '待判'
  return stageM > previousStageM ? '涨水' : '落水'
}

/** 推断单个测次的涨落趋势，调用方需保证 sections 为同站并按时间升序 */
export function inferSectionTrend(section: Section, orderedSections: Section[]): StageTrend {
  const time = Date.parse(section.measuredAt)
  if (!Number.isFinite(time)) return '待判'

  const previous = orderedSections
    .filter((item) => {
      const itemTime = Date.parse(item.measuredAt)
      return item.id !== section.id && Number.isFinite(itemTime) && itemTime < time
    })
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))[0]

  return trendByStage(previous?.stageM, section.stageM)
}

/** 为整组测次回填涨落趋势，按测站分别排序 */
export function inferSectionTrends(sections: Section[]): Map<string, StageTrend> {
  const result = new Map<string, StageTrend>()
  const byStation = new Map<string, Section[]>()
  sections.forEach((section) => {
    const list = byStation.get(section.stationId) ?? []
    list.push(section)
    byStation.set(section.stationId, list)
  })

  byStation.forEach((stationSections) => {
    const ordered = stationSections
      .filter((section) => Number.isFinite(Date.parse(section.measuredAt)))
      .sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt))
    ordered.forEach((section, index) => {
      result.set(section.id, trendByStage(ordered[index - 1]?.stageM, section.stageM))
    })
    stationSections
      .filter((section) => !Number.isFinite(Date.parse(section.measuredAt)))
      .forEach((section) => result.set(section.id, '待判'))
  })

  return result
}

/**
 * 关系点据升级回填：优先匹配同站同测次号；匹配不到时，按点据时间取该站此前最近一次测次。
 */
export function inferRatingTrend(rating: Rating, sections: Section[]): StageTrend {
  const sameStation = sections.filter((section) => section.stationId === rating.stationId)
  const exact = sameStation.find((section) => section.measureNo === rating.measureNo)
  if (exact) return exact.stageTrend

  const ratingTime = Date.parse(rating.measuredAt)
  if (!Number.isFinite(ratingTime)) return '待判'

  const previous = sameStation
    .filter((section) => Number.isFinite(Date.parse(section.measuredAt)) && Date.parse(section.measuredAt) <= ratingTime)
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))[0]

  return previous?.stageTrend ?? '待判'
}

export function isRatingBranch(value: StageTrend | undefined): value is RatingBranch {
  return value === '涨水' || value === '落水'
}

/** 定线号 + 支线的稳定键，展示与 store 分组共用 */
export function branchFitKey(lineNo: string, branch: RatingBranch): string {
  return `${lineNo}#${branch}`
}

export function branchFitLabel(lineNo: string, branch: RatingBranch): string {
  return `${lineNo} 线${branch}支`
}
