/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/** 涨落标记：涨水 / 落水（绳套曲线按涨落两支分别定线） */
export type RiseFall = 'rising' | 'falling'

export const RISE_FALLS: RiseFall[] = ['rising', 'falling']

/** 涨落标记中文文案 */
export const RISE_FALL_LABELS: Record<RiseFall, string> = {
  rising: '涨水',
  falling: '落水'
}

/** 涨落标记标签类型（用于 el-tag 配色） */
export const RISE_FALL_TAG_TYPES: Record<RiseFall, 'danger' | 'primary'> = {
  rising: 'danger',
  falling: 'primary'
}

/** 涨落标记中文文案（空值返回「未标记」） */
export function riseFallLabelOf(riseFall: RiseFall | null | undefined): string {
  return riseFall ? RISE_FALL_LABELS[riseFall] : '未标记'
}

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
  /** 涨落标记：涨水 / 落水；未标记为空 */
  riseFall: RiseFall | null
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
