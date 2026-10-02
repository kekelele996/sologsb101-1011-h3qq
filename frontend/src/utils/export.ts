/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入。
 * 与 utils/db.ts 的 BackupPayload 结构保持一致。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import type { Compare } from '@/types/compare'
import type { Rating } from '@/types/rating'
import type { RatingVersion } from '@/types/ratingVersion'
import type { Section } from '@/types/section'
import { inferRatingTrend, inferSectionTrends, isRatingBranch } from '@/utils/stageTrend'
import { compareIdOf, createRatingVersion, ratingGroupKey } from '@/utils/ratingVersion'

/** 备份集合键名 */
export const BACKUP_KEYS = [
  'stations',
  'sections',
  'verticals',
  'points',
  'ratings',
  'compares',
  'ratingVersions'
] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

/** 各表行数统计（导出页展示与导入结果回执共用） */
export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [stations, sections, verticals, points, ratings, compares, ratingVersions] = await Promise.all([
    db.stations.toArray(),
    db.sections.toArray(),
    db.verticals.toArray(),
    db.points.toArray(),
    db.ratings.toArray(),
    db.compares.toArray(),
    db.ratingVersions.toArray()
  ])
  return {
    app: 'gbhydrogaug',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations,
    sections,
    verticals,
    points,
    ratings,
    compares,
    ratingVersions
  }
}

function normalizeSections(sections: Section[]): Section[] {
  const trends = inferSectionTrends(sections)
  return sections.map((section) => ({
    ...section,
    stageTrend: section.stageTrend ?? trends.get(section.id) ?? '待判'
  }))
}

function normalizeRatings(ratings: Rating[], sections: Section[]): Rating[] {
  return ratings.map((rating) => ({
    ...rating,
    stageTrend: rating.stageTrend ?? inferRatingTrend(rating, sections)
  }))
}

/**
 * 兼容旧备份：没有涨落标记时按测流时间回填；没有定线版本时，把旧比测结论封存成第 1 版。
 */
function normalizeLegacyVersioning(payload: BackupPayload): BackupPayload {
  if (payload.ratingVersions.length > 0 || payload.ratings.length === 0) return payload

  const oldByRating = new Map(payload.compares.map((compare) => [compare.ratingId, compare]))
  const groups = new Map<string, Rating[]>()
  payload.ratings.forEach((rating) => {
    const key = ratingGroupKey(rating.stationId, rating.lineNo)
    const list = groups.get(key) ?? []
    list.push(rating)
    groups.set(key, list)
  })

  const now = Date.now()
  const versions: RatingVersion[] = []
  const compares: Compare[] = []
  let index = 0
  groups.forEach((group, key) => {
    const [stationId, lineNo] = key.split(' ')
    const versionId = `ver_import_${String(index + 1).padStart(3, '0')}`
    const version = createRatingVersion(group, {
      id: versionId,
      stationId,
      lineNo,
      versionNo: 1,
      status: 'published',
      note: '旧备份导入：封存导入前比测结论',
      now,
      previous: payload.compares
    })

    version.compares = group.flatMap((rating) => {
      const old = oldByRating.get(rating.id)
      const generated = version.compares.find((item) => item.ratingId === rating.id)
      if (!old) return generated ? [generated] : []
      return [{
        ratingId: rating.id,
        stageM: rating.stageM,
        measuredFlow: old.measuredFlow,
        curveFlow: old.curveFlow,
        deviationPct: old.deviationPct,
        verdict: old.verdict,
        branch: isRatingBranch(rating.stageTrend) ? rating.stageTrend : undefined,
        operator: old.operator,
        comparedAt: old.comparedAt
      }]
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
        operator: item.operator,
        comparedAt: item.comparedAt,
        createdAt: now,
        updatedAt: now
      })
    })
    versions.push(version)
    index += 1
  })

  return { ...payload, ratingVersions: versions, compares }
}

/** 补齐旧版本备份缺省字段，导入后仍能按 v3 结构运行 */
export function normalizeBackupPayload(input: BackupPayload): BackupPayload {
  const sections = normalizeSections(input.sections)
  const ratings = normalizeRatings(input.ratings, sections)
  const ratingVersions = Array.isArray(input.ratingVersions) ? input.ratingVersions : []
  const compares = input.compares.map((compare) => {
    const rating = ratings.find((item) => item.id === compare.ratingId)
    return {
      ...compare,
      versionId: compare.versionId ?? 'ver_legacy',
      branch: compare.branch ?? (rating && isRatingBranch(rating.stageTrend) ? rating.stageTrend : undefined)
    } as Compare
  }).filter((compare): compare is Compare => Boolean(compare.branch))

  return normalizeLegacyVersioning({
    ...input,
    dbVersion: DB_VERSION,
    sections,
    ratings,
    compares,
    ratingVersions
  })
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbhydrogaug' && obj.app !== undefined) {
    errors.push('app 字段应为 gbhydrogaug，文件来源不明')
  }
  for (const key of BACKUP_KEYS) {
    // ratingVersions 是 v3 新表，旧备份允许缺失
    if (key === 'ratingVersions') continue
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const raw: BackupPayload = {
    app: 'gbhydrogaug',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    stations: obj.stations ?? [],
    sections: obj.sections ?? [],
    verticals: obj.verticals ?? [],
    points: obj.points ?? [],
    ratings: obj.ratings ?? [],
    compares: obj.compares ?? [],
    ratingVersions: obj.ratingVersions ?? []
  }
  return { ok: true, errors, payload: normalizeBackupPayload(raw) }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    stations: payload.stations.length,
    sections: payload.sections.length,
    verticals: payload.verticals.length,
    points: payload.points.length,
    ratings: payload.ratings.length,
    compares: payload.compares.length,
    ratingVersions: payload.ratingVersions.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  const normalized = normalizeBackupPayload(payload)
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.ratingVersions],
    async () => {
      await db.stations.bulkPut(normalized.stations)
      await db.sections.bulkPut(normalized.sections)
      await db.verticals.bulkPut(normalized.verticals)
      await db.points.bulkPut(normalized.points)
      await db.ratings.bulkPut(normalized.ratings)
      await db.ratingVersions.bulkPut(normalized.ratingVersions)
      await db.compares.bulkPut(normalized.compares)
    }
  )
  return countPayload(normalized)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const stationMap = new Map<string, string>()
  const sectionMap = new Map<string, string>()
  const verticalMap = new Map<string, string>()
  const ratingMap = new Map<string, string>()
  const versionMap = new Map<string, string>()

  const stations = payload.stations.map((station) => {
    const id = createId('stn')
    stationMap.set(station.id, id)
    return { ...station, id }
  })
  const sections = payload.sections.map((sectionRow) => {
    const id = createId('sec')
    sectionMap.set(sectionRow.id, id)
    return { ...sectionRow, id, stationId: stationMap.get(sectionRow.stationId) ?? sectionRow.stationId }
  })
  const verticals = payload.verticals.map((vertical) => {
    const id = createId('vrt')
    verticalMap.set(vertical.id, id)
    return { ...vertical, id, sectionId: sectionMap.get(vertical.sectionId) ?? vertical.sectionId }
  })
  const points = payload.points.map((point) => ({
    ...point,
    id: createId('pnt'),
    verticalId: verticalMap.get(point.verticalId) ?? point.verticalId
  }))
  const ratings = payload.ratings.map((rating) => {
    const id = createId('rat')
    ratingMap.set(rating.id, id)
    return { ...rating, id, stationId: stationMap.get(rating.stationId) ?? rating.stationId }
  })
  const ratingVersions = payload.ratingVersions.map((version) => {
    const id = createId('ver')
    versionMap.set(version.id, id)
    return {
      ...version,
      id,
      stationId: stationMap.get(version.stationId) ?? version.stationId,
      compares: version.compares.map((item) => ({ ...item, ratingId: ratingMap.get(item.ratingId) ?? item.ratingId }))
    }
  })
  const compares = payload.compares.map((compare) => {
    const oldVersionId = versionMap.get(compare.versionId) ?? compare.versionId
    const ratingId = ratingMap.get(compare.ratingId) ?? compare.ratingId
    return {
      ...compare,
      id: compareIdOf(oldVersionId, ratingId),
      versionId: oldVersionId,
      ratingId
    }
  })
  return { ...payload, stations, sections, verticals, points, ratings, compares, ratingVersions }
}

/**
 * 生成结论文本：按测站输出最新水位、断面测次、涨 / 落双支线定线参数与超限点据。
 * 供导出页的「检测结论」区域使用。
 */
export interface ConclusionLine {
  stationId: string
  stationName: string
  river: string
  sectionCount: number
  latestStageM: number | null
  ratingCount: number
  overLimitCount: number
  fitText: string
}

export function buildConclusionLines(
  payload: BackupPayload,
  fits: Array<{ lineNo: string; branch?: string; valid: boolean; a: number; b: number; h0: number; meanResidualPct: number; sampleCount: number }>
): ConclusionLine[] {
  const latestVersions = new Map<string, RatingVersion>()
  payload.ratingVersions
    .filter((version) => version.status === 'published')
    .sort((a, b) => a.versionNo - b.versionNo)
    .forEach((version) => latestVersions.set(ratingGroupKey(version.stationId, version.lineNo), version))

  return payload.stations.map((station) => {
    const stationSections = payload.sections.filter((sectionRow) => sectionRow.stationId === station.id)
    const latest = stationSections.reduce<number | null>((acc, sectionRow) => {
      if (acc === null) return sectionRow.stageM
      return sectionRow.stageM > acc ? sectionRow.stageM : acc
    }, null)
    const ratings = payload.ratings.filter((rating) => rating.stationId === station.id)
    const currentVersionIds = new Set(Array.from(latestVersions.values()).filter((version) => version.stationId === station.id).map((version) => version.id))
    const overLimitCount = payload.compares.filter(
      (compare) => currentVersionIds.has(compare.versionId) && ratings.some((rating) => rating.id === compare.ratingId) && compare.verdict === '超限'
    ).length
    const lines = Array.from(new Set(ratings.map((rating) => rating.lineNo)))
    const fitParts = lines.flatMap((lineNo) => {
      const version = latestVersions.get(ratingGroupKey(station.id, lineNo))
      if (!version) return [`${lineNo} 线未定线`]
      return version.fits.map((fit) => {
        if (!fit.valid || !fit.branch) return `${lineNo} 线${fit.branch ?? ''}支未定线`
        return `${lineNo} 线${fit.branch}支 v${version.versionNo} Q=${fit.a}·(H-${fit.h0})^${fit.b}，残差 ${fit.meanResidualPct}%（${fit.sampleCount} 点）`
      })
    })
    return {
      stationId: station.id,
      stationName: station.name,
      river: station.river,
      sectionCount: stationSections.length,
      latestStageM: latest,
      ratingCount: ratings.length,
      overLimitCount,
      fitText: fitParts.length > 0 ? fitParts.join('；') : '暂无关系点据'
    }
  })
}
