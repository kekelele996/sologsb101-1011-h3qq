/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（测站 → 断面 → 垂线 → 测点 → 点据 → 定线版本 / 比测）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section, StageTrend } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { RatingVersion, RatingVersionCompare } from '@/types/ratingVersion'
import { DEFAULT_WEIGHTS, calcMeanVelocity } from '@/utils/flow'
import { inferRatingTrend, inferSectionTrends, isRatingBranch } from '@/utils/stageTrend'
import { compareIdOf, createRatingVersion } from '@/utils/ratingVersion'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  compares: Compare[]
  ratingVersions: RatingVersion[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  compares!: Table<Compare, string>
  ratingVersions!: Table<RatingVersion, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })

    // v2：补齐筛选与统计需要的索引（河名/集水面积、水位、测法、偏差判定）
    this.version(2)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1 → v2：历史数据补齐时间戳与判定结论，避免列表排序与筛选拿到 undefined
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', () => ({ measuredAt: new Date().toISOString() })],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
          ['ratings', () => ({ measureNo: '', lineNo: 'A' })],
          ['compares', () => ({ operator: '', comparedAt: new Date().toISOString() })]
        ]
        for (const [tableName, defaults] of stamps) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, defaults())
            })
        }
      })

    // v3：测次增加涨落标记，点据按涨 / 落两支拟合，定线成果按版本封存
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, stageTrend, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings: 'id, stationId, lineNo, stageTrend, stageM, flowM3s, measuredAt, updatedAt',
        compares: 'id, versionId, ratingId, branch, verdict, deviationPct, comparedAt, updatedAt',
        ratingVersions: 'id, stationId, lineNo, versionNo, status, publishedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1/v2 字段补齐，防止更早数据缺字段
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', () => ({ measuredAt: new Date().toISOString(), stageTrend: '待判' })],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
          ['ratings', () => ({ measureNo: '', lineNo: 'A', stageTrend: '待判' })],
          ['compares', () => ({ operator: '', comparedAt: new Date().toISOString() })]
        ]
        for (const [tableName, defaults] of stamps) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.entries(defaults()).forEach(([key, value]) => {
                if (row[key] === undefined) row[key] = value
              })
            })
        }

        const sections = await tx.table<Section, string>('sections').toArray()
        const ratings = await tx.table<Rating, string>('ratings').toArray()
        const oldCompares = await tx.table<Compare, string>('compares').toArray()
        const now = Date.now()

        // 已有数据没有涨落标记：按同站测流时间与前一测次水位回填，首测次、平峰等列为待判。
        const sectionTrends = inferSectionTrends(sections)
        await tx
          .table<Section, string>('sections')
          .toCollection()
          .modify((section) => {
            const trend = sectionTrends.get(section.id)
            section.stageTrend = trend ?? '待判'
            section.updatedAt = now
          })
        sections.forEach((section) => {
          section.stageTrend = sectionTrends.get(section.id) ?? '待判'
        })

        const ratingTrends = new Map<string, StageTrend>()
        ratings.forEach((rating) => ratingTrends.set(rating.id, inferRatingTrend(rating, sections)))
        await tx
          .table<Rating, string>('ratings')
          .toCollection()
          .modify((rating) => {
            rating.stageTrend = ratingTrends.get(rating.id) ?? '待判'
            rating.updatedAt = now
          })
        ratings.forEach((rating) => {
          rating.stageTrend = ratingTrends.get(rating.id) ?? '待判'
        })

        // 把升级前的一条线拟合结果封存为第 1 版，并尽量原样保留当时的比测偏差和结论。
        const oldCompareByRating = new Map(oldCompares.map((compare) => [compare.ratingId, compare]))
        const groupMap = new Map<string, Rating[]>()
        ratings.forEach((rating) => {
          const key = `${rating.stationId} ${rating.lineNo}`
          const list = groupMap.get(key) ?? []
          list.push(rating)
          groupMap.set(key, list)
        })

        const versions: RatingVersion[] = []
        const currentCompares: Compare[] = []
        let groupIndex = 0
        groupMap.forEach((groupRatings, key) => {
          const [stationId, lineNo] = key.split(' ')
          const versionId = `ver_mig_${String(groupIndex + 1).padStart(3, '0')}`
          const version = createRatingVersion(groupRatings, {
            id: versionId,
            stationId,
            lineNo,
            versionNo: 1,
            status: 'published',
            note: '升级迁移：按回填涨落标记建立双支线初版，并封存原比测结论',
            now,
            previous: oldCompares
          })

          const preserved: RatingVersionCompare[] = []
          groupRatings.forEach((rating) => {
            const oldCompare = oldCompareByRating.get(rating.id)
            if (!oldCompare) return
            const trend = rating.stageTrend
            const knownBranch = isRatingBranch(trend) ? trend : undefined
            const snapshot: RatingVersionCompare = {
              ratingId: rating.id,
              stageM: rating.stageM,
              measuredFlow: oldCompare.measuredFlow,
              curveFlow: oldCompare.curveFlow,
              deviationPct: oldCompare.deviationPct,
              verdict: oldCompare.verdict,
              branch: knownBranch,
              operator: oldCompare.operator,
              comparedAt: oldCompare.comparedAt
            }
            preserved.push(snapshot)
            if (knownBranch) {
              currentCompares.push({
                ...oldCompare,
                id: compareIdOf(versionId, rating.id),
                versionId,
                branch: knownBranch,
                createdAt: oldCompare.createdAt ?? now,
                updatedAt: now
              })
            }
          })

          const generatedKnown = version.compares.filter((item) => !oldCompareByRating.has(item.ratingId))
          generatedKnown.forEach((item) => {
            if (!item.branch) return
            preserved.push(item)
            currentCompares.push({
              id: compareIdOf(versionId, item.ratingId),
              versionId,
              ratingId: item.ratingId,
              branch: item.branch,
              measuredFlow: item.measuredFlow,
              curveFlow: item.curveFlow,
              deviationPct: item.deviationPct,
              verdict: item.verdict,
              operator: item.operator,
              comparedAt: item.comparedAt,
              createdAt: now,
              updatedAt: now
            })
          })
          version.compares = preserved
          versions.push(version)
          groupIndex += 1
        })

        await tx.table('compares').clear()
        await tx.table('ratingVersions').bulkPut(versions)
        await tx.table('compares').bulkPut(currentCompares)
      })
  }
}

export const db = new HydroGaugeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedStationBundle {
  station: Omit<Station, 'createdAt' | 'updatedAt'>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
}

function section(
  id: string,
  stationId: string,
  measureNo: string,
  stageM: number,
  method: Section['method'],
  measuredAt: string,
  stageTrend: StageTrend,
  startDistanceM = 12.5
): Omit<Section, 'createdAt' | 'updatedAt'> {
  return { id, stationId, measureNo, startDistanceM, stageM, method, stageTrend, measuredAt }
}

/**
 * 播种演示数据：3 个测站 → 18 个断面测次 → 8 条垂线 → 16 个流速测点，
 * 并生成水位流量关系点据、涨 / 落双支线定线版本与比测记录。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      sections: [
        section('sec_lh_2406', 'stn_lh01', '2024-06-001', 5.42, '流速仪', '2024-06-12T08:30:00.000Z', '涨水'),
        section('sec_lh_2407', 'stn_lh01', '2024-07-002', 6.15, 'ADCP', '2024-07-18T09:10:00.000Z', '涨水'),
        section('sec_lh_2409a', 'stn_lh01', '2024-09-003', 5.88, 'ADCP', '2024-09-02T08:40:00.000Z', '落水'),
        section('sec_lh_2409b', 'stn_lh01', '2024-09-004', 5.35, 'ADCP', '2024-09-12T08:40:00.000Z', '落水'),
        section('sec_lh_2409c', 'stn_lh01', '2024-09-005', 4.95, 'ADCP', '2024-09-22T08:40:00.000Z', '落水')
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.62, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.48, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.42, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.18, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 0.96, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 0.82, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.64, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.64, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.32, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      sections: [
        section('sec_qj_2405', 'stn_qj02', '2024-05-003', 3.18, '浮标', '2024-05-22T07:50:00.000Z', '涨水', 4.2),
        section('sec_qj_2408', 'stn_qj02', '2024-08-004', 4.36, '流速仪', '2024-08-09T06:40:00.000Z', '涨水', 4.2),
        section('sec_qj_2409a', 'stn_qj02', '2024-09-005', 3.92, '流速仪', '2024-09-03T07:20:00.000Z', '落水', 4.2),
        section('sec_qj_2409b', 'stn_qj02', '2024-09-006', 3.45, '浮标', '2024-09-13T07:20:00.000Z', '落水', 4.2),
        section('sec_qj_2409c', 'stn_qj02', '2024-09-007', 3.05, '浮标', '2024-09-23T07:20:00.000Z', '落水', 4.2)
      ],
      verticals: [
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.54, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.42, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 0.88, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 0.7, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.06, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.92, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.78, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.34, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.2, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 1.04, weight: 1 / 3, durationS: 100 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        remark: '巡测断面，与龙门站比测'
      },
      sections: [
        section('sec_bs_2405', 'stn_bs03', '2024-05-004', 4.9, 'ADCP', '2024-05-28T09:00:00.000Z', '涨水', 18),
        section('sec_bs_2406', 'stn_bs03', '2024-06-005', 5.36, 'ADCP', '2024-06-20T10:05:00.000Z', '涨水', 18),
        section('sec_bs_2407', 'stn_bs03', '2024-07-007', 5.88, 'ADCP', '2024-07-25T09:30:00.000Z', '涨水', 18),
        section('sec_bs_2408', 'stn_bs03', '2024-08-008', 6.44, 'ADCP', '2024-08-15T09:40:00.000Z', '涨水', 18),
        section('sec_bs_2409a', 'stn_bs03', '2024-09-009', 6.1, 'ADCP', '2024-09-02T10:20:00.000Z', '落水', 18),
        section('sec_bs_2409b', 'stn_bs03', '2024-09-010', 5.6, 'ADCP', '2024-09-12T10:20:00.000Z', '落水', 18),
        section('sec_bs_2409c', 'stn_bs03', '2024-09-011', 5.0, 'ADCP', '2024-09-22T10:20:00.000Z', '落水', 18),
        section('sec_bs_2409d', 'stn_bs03', '2024-09-012', 4.7, 'ADCP', '2024-10-02T10:20:00.000Z', '落水', 18)
      ],
      verticals: [
        { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面' },
        { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面' }
      ],
      points: [
        { id: 'pnt_bs_11', verticalId: 'vrt_bs_1', relativeDepth: 0.2, velocityMs: 1.22, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_12', verticalId: 'vrt_bs_1', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_13', verticalId: 'vrt_bs_1', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_21', verticalId: 'vrt_bs_2', relativeDepth: 0.2, velocityMs: 1.46, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_22', verticalId: 'vrt_bs_2', relativeDepth: 0.6, velocityMs: 1.3, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_23', verticalId: 'vrt_bs_2', relativeDepth: 0.8, velocityMs: 1.1, weight: 1 / 3, durationS: 120 }
      ]
    }
  ]

  // 水位流量关系点据：A/B/C 三组均包含涨水支与落水支，C 线保留超限点演示
  const ratingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt'>> = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', stageTrend: '涨水', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', stageTrend: '涨水', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', stageTrend: '涨水', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', stageTrend: '涨水', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', stageTrend: '涨水', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z' },
    { id: 'rat_lh_f1', stationId: 'stn_lh01', stageM: 5.88, flowM3s: 238.4, lineNo: 'A', stageTrend: '落水', measureNo: '2024-09-003', measuredAt: '2024-09-02T08:40:00.000Z' },
    { id: 'rat_lh_f2', stationId: 'stn_lh01', stageM: 5.35, flowM3s: 181.6, lineNo: 'A', stageTrend: '落水', measureNo: '2024-09-004', measuredAt: '2024-09-12T08:40:00.000Z' },
    { id: 'rat_lh_f3', stationId: 'stn_lh01', stageM: 4.95, flowM3s: 150.2, lineNo: 'A', stageTrend: '落水', measureNo: '2024-09-005', measuredAt: '2024-09-22T08:40:00.000Z' },

    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', stageTrend: '涨水', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', stageTrend: '涨水', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', stageTrend: '涨水', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', stageTrend: '涨水', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z' },
    { id: 'rat_qj_f1', stationId: 'stn_qj02', stageM: 3.92, flowM3s: 84.2, lineNo: 'B', stageTrend: '落水', measureNo: '2024-09-005', measuredAt: '2024-09-03T07:20:00.000Z' },
    { id: 'rat_qj_f2', stationId: 'stn_qj02', stageM: 3.45, flowM3s: 60.8, lineNo: 'B', stageTrend: '落水', measureNo: '2024-09-006', measuredAt: '2024-09-13T07:20:00.000Z' },
    { id: 'rat_qj_f3', stationId: 'stn_qj02', stageM: 3.05, flowM3s: 47.6, lineNo: 'B', stageTrend: '落水', measureNo: '2024-09-007', measuredAt: '2024-09-23T07:20:00.000Z' },

    // C 线：涨水 / 落水支各有偏离点，用于演示绳套两支分别挂红与偏差分析
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', stageTrend: '涨水', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', stageTrend: '涨水', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', stageTrend: '涨水', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 388.0, lineNo: 'C', stageTrend: '涨水', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z' },
    { id: 'rat_bs_f1', stationId: 'stn_bs03', stageM: 6.1, flowM3s: 250.0, lineNo: 'C', stageTrend: '落水', measureNo: '2024-09-009', measuredAt: '2024-09-02T10:20:00.000Z' },
    { id: 'rat_bs_f2', stationId: 'stn_bs03', stageM: 5.6, flowM3s: 236.0, lineNo: 'C', stageTrend: '落水', measureNo: '2024-09-010', measuredAt: '2024-09-12T10:20:00.000Z' },
    { id: 'rat_bs_f3', stationId: 'stn_bs03', stageM: 5.0, flowM3s: 260.0, lineNo: 'C', stageTrend: '落水', measureNo: '2024-09-011', measuredAt: '2024-09-22T10:20:00.000Z' },
    { id: 'rat_bs_f4', stationId: 'stn_bs03', stageM: 4.7, flowM3s: 180.0, lineNo: 'C', stageTrend: '落水', measureNo: '2024-09-012', measuredAt: '2024-10-02T10:20:00.000Z' }
  ]

  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.ratingVersions],
    async () => {
      const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
        createdAt: now + row.id.length,
        updatedAt: now + row.id.length
      })

      await db.stations.bulkPut(
        stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) }))
      )
      await db.sections.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.sections.map((sectionRow) => ({ ...sectionRow, ...stamp(sectionRow) }))
        )
      )
      await db.verticals.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        )
      )
      await db.points.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.points.map((point) => ({ ...point, ...stamp(point) }))
        )
      )
      const stampedRatings: Rating[] = ratingSeeds.map((rating) => ({ ...rating, ...stamp(rating) }))
      await db.ratings.bulkPut(stampedRatings)

      const groups = new Map<string, Rating[]>()
      stampedRatings.forEach((rating) => {
        const key = `${rating.stationId} ${rating.lineNo}`
        const list = groups.get(key) ?? []
        list.push(rating)
        groups.set(key, list)
      })

      const versions: RatingVersion[] = []
      const compares: Compare[] = []
      groups.forEach((group, key) => {
        const [stationId, lineNo] = key.split(' ')
        const versionId = `ver_${lineNo.toLowerCase()}_1`
        const version = createRatingVersion(group, {
          id: versionId,
          stationId,
          lineNo,
          versionNo: 1,
          status: 'published',
          note: '演示数据：发布的涨 / 落双支线初版定线',
          now
        })
        version.compares.forEach((item) => {
          if (!item.branch) return
          compares.push({
            id: compareIdOf(versionId, item.ratingId),
            versionId,
            ratingId: item.ratingId,
            branch: item.branch,
            measuredFlow: item.measuredFlow,
            curveFlow: item.curveFlow,
            deviationPct: item.deviationPct,
            verdict: item.verdict,
            operator: lineNo === 'C' ? '周渝' : '林昭',
            comparedAt: item.comparedAt,
            createdAt: now,
            updatedAt: now
          })
        })
        versions.push(version)
      })

      await db.ratingVersions.bulkPut(versions)
      await db.compares.bulkPut(compares)
    }
  )
}

/** 打开数据库并幂等播种：仅当测站表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.stations.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.ratingVersions],
    async () => {
      await Promise.all([
        db.stations.clear(),
        db.sections.clear(),
        db.verticals.clear(),
        db.points.clear(),
        db.ratings.clear(),
        db.compares.clear(),
        db.ratingVersions.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [stations, sections, verticals, points, ratings, compares, ratingVersions] = await Promise.all([
    db.stations.count(),
    db.sections.count(),
    db.verticals.count(),
    db.points.count(),
    db.ratings.count(),
    db.compares.count(),
    db.ratingVersions.count()
  ])
  return { stations, sections, verticals, points, ratings, compares, ratingVersions }
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面与播种共用同一套算法） */
export function verticalMeanVelocity(points: Point[]): number {
  return calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}
