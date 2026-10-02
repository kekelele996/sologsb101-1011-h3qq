/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/** 水位涨落趋势：巡测班在测次上标记，无法由时间序列判明时列为待判 */
export type StageTrend = '涨水' | '落水' | '待判'

export const STAGE_TRENDS: StageTrend[] = ['涨水', '落水', '待判']

/** 可参与绳套曲线支线拟合的涨落趋势 */
export type RatingBranch = Exclude<StageTrend, '待判'>

export const RATING_BRANCHES: RatingBranch[] = ['涨水', '落水']

/** 断面测次：一次完整的流量测验 */
export interface Section {
  id: string
  /** 所属测站 */
  stationId: string
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 起点距（m）：断面起点到测流断面的距离 */
  startDistanceM: number
  /** 水位（m） */
  stageM: number
  /** 流速仪 / 浮标 / ADCP */
  method: MeasureMethod
  /** 本趟测验所处的涨落水支线 */
  stageTrend: StageTrend
  /** 测流时间 */
  measuredAt: string
  createdAt: number
  updatedAt: number
}

/** 断面列表页的筛选条件（存于 sectionStore） */
export interface SectionFilterState {
  keyword: string
  methods: MeasureMethod[]
  /** 水位下限（m） */
  minStageM: number | null
}

export function createEmptySectionFilter(): SectionFilterState {
  return {
    keyword: '',
    methods: [],
    minStageM: null
  }
}
