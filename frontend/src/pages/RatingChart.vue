<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与绳套曲线定线
 * 点据按涨水 / 落水两支分别做幂函数拟合；发布版本封存定线参数和比测结论。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Back, Delete, Edit, Plus, Promotion, Refresh, TrendCharts, Warning } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore, type RatingPointRow } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import type { Rating } from '@/types/rating'
import { RATING_BRANCHES, type RatingBranch, type StageTrend } from '@/types/section'
import { branchFitLabel } from '@/utils/stageTrend'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  stationId: '',
  stageM: 0,
  flowM3s: 0,
  lineNo: 'A',
  stageTrend: '涨水' as StageTrend,
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

const fit = computed(() => ratingStore.activeFit)
const activeVersion = computed(() => ratingStore.activeVersion)
const pointRows = computed<RatingPointRow[]>(() => ratingStore.pointRows)
const pendingRows = computed(() => ratingStore.pendingRatings)
const stationId = computed(() => ratingStore.effectiveStationId)
const lineNo = computed(() => ratingStore.effectiveLineNo)
const branch = computed(() => ratingStore.activeBranch)

const stationOptions = computed(() =>
  stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
)
const lineOptions = computed(() => {
  const values = new Set(
    ratingStore.groups
      .filter((group) => group.stationId === stationId.value)
      .map((group) => group.lineNo)
  )
  if (lineNo.value) values.add(lineNo.value)
  return Array.from(values).sort((a, b) => a.localeCompare(b))
})
const versionOptions = computed(() =>
  ratingStore.groupVersions.map((version) => ({
    label: `v${version.versionNo} ${version.status === 'draft' ? '草稿' : version.status === 'published' ? '发布版' : '归档版'}`,
    value: version.id
  }))
)
const versionStatusText: Record<string, string> = {
  draft: '草稿（点据变化后可重算）',
  published: '已发布（本版已封存）',
  archived: '已归档（历史版本）'
}

const filterModel = computed(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  branches: ratingStore.filter.branches,
  verdicts: ratingStore.filter.verdicts
}))

/** 关系曲线坐标：横轴水位、纵轴流量；涨 / 落支用不同曲线颜色绘制 */
const chart = computed(() => {
  const rows = pointRows.value
  if (rows.length === 0) {
    return { samples: '', points: [] as Array<{ id: string; cx: number; cy: number; verdict: string }>, stageMin: 0, stageMax: 0, flowMax: 0 }
  }
  const stages = rows.map((row) => row.stageM)
  const flows = rows.map((row) => row.measuredFlow)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...flows) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)
  const sampleCount = 13
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const stageM = stageMin + ((stageMax - stageMin) * index) / (sampleCount - 1 || 1)
    const value = fit.value.valid ? fit.value.a * Math.pow(Math.max(stageM - fit.value.h0, 1e-6), fit.value.b) : 0
    return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
  }).join(' ')
  return {
    samples,
    points: rows.map((row) => ({
      id: row.ratingId,
      cx: toX(row.stageM),
      cy: toY(row.measuredFlow),
      verdict: row.verdict
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

const branchColor = computed(() => (branch.value === '涨水' ? '#0f4c75' : '#c47f17'))

function handleStationChange(value: string | number | boolean | undefined): void {
  const nextStationId = String(value)
  ratingStore.setActiveStation(nextStationId)
  const firstLine = ratingStore.groups.find((group) => group.stationId === nextStationId)?.lineNo ?? 'A'
  ratingStore.setActiveLine(firstLine)
  ratingStore.selectVersion(null)
}

function handleLineChange(value: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(value))
  ratingStore.selectVersion(null)
}

function handleBranchChange(value: string | number | boolean | undefined): void {
  ratingStore.setActiveBranch(String(value) as RatingBranch)
}

function handleVersionChange(value: string | number | boolean | undefined): void {
  ratingStore.selectVersion(value ? String(value) : null)
}

function backToCurrent(): void {
  ratingStore.selectVersion(ratingStore.draftVersion?.id ?? ratingStore.latestPublishedVersion?.id ?? null)
}

function openCreate(): void {
  editingId.value = null
  form.stationId = stationId.value || stationStore.stations[0]?.id || ''
  form.lineNo = lineNo.value || 'A'
  form.stageTrend = branch.value
  const last = pointRows.value[pointRows.value.length - 1]
  form.stageM = last ? Number((last.stageM + 0.2).toFixed(2)) : 3
  form.flowM3s = last ? Number((last.measuredFlow * 1.2).toFixed(1)) : 50
  form.measureNo = `${new Date().getFullYear()}-${String(ratingStore.ratings.length + 1).padStart(3, '0')}`
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(row: RatingPointRow): void {
  if (!row.rating) {
    ElMessage.warning('该点据来自历史版本快照，当前库中已不存在，不能编辑')
    return
  }
  const rating: Rating = row.rating
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.stageTrend = rating.stageTrend
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写水位（m）')
    return
  }
  if (!Number.isFinite(form.flowM3s) || form.flowM3s <= 0) {
    ElMessage.warning('流量应为大于 0 的数字（m³/s）')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      stageM: form.stageM,
      flowM3s: form.flowM3s,
      lineNo: form.lineNo.trim() || 'A',
      stageTrend: form.stageTrend,
      measureNo: form.measureNo.trim(),
      measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString()
    }
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('点据已更新；受影响支线已另起草稿重算')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success('点据已新增，所在支线已重算')
    }
    ratingStore.setActiveStation(payload.stationId)
    ratingStore.setActiveLine(payload.lineNo)
    if (payload.stageTrend !== '待判') ratingStore.setActiveBranch(payload.stageTrend)
    ratingStore.selectVersion(null)
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeRating(row: RatingPointRow): Promise<void> {
  if (!row.rating) return
  try {
    await ElMessageBox.confirm(
      `删除水位 ${row.rating.stageM.toFixed(2)} m 处的点据将生成新的草稿；历史发布版本仍保留。确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(row.rating.id)
  ElMessage.success('点据已删除，所在支线已重算')
}

async function refit(): Promise<void> {
  const version = await ratingStore.rebuildGroupCompares(stationId.value, lineNo.value)
  const result = version?.fits.find((item) => item.branch === branch.value)
  if (result?.valid) {
    ElMessage.success(
      `v${version?.versionNo} 草稿 ${branchFitLabel(lineNo.value, branch.value)}：Q = ${result.a}×(H-${result.h0})^${result.b}，平均残差 ${result.meanResidualPct}%`
    )
  } else {
    ElMessage.warning(result?.message || '当前支点点据不足以定线')
  }
}

async function publish(): Promise<void> {
  const draft = ratingStore.draftVersion
  if (!draft) {
    ElMessage.info('当前没有待发布草稿；点据或涨落标记变化后才需要发布新版')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将发布 ${lineNo.value} 线第 ${draft.versionNo} 版，并封存涨水、落水两支的拟合参数与比测结论。已发布旧版不会被覆盖。`,
      '发布定线版本',
      { type: 'info', confirmButtonText: '发布新版', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const published = await ratingStore.publishVersion(draft.id)
  if (published) ElMessage.success(`第 ${published.versionNo} 版定线已发布封存`)
}

async function resolvePendingTrend(rating: Rating, value: StageTrend): Promise<void> {
  if (value === '待判') return
  ratingStore.setActiveStation(rating.stationId)
  ratingStore.setActiveLine(rating.lineNo)
  await ratingStore.setPendingRatingTrend(rating.id, value)
  ratingStore.setActiveBranch(value)
  ElMessage.success(`点据已归入${value}支，所在支线已重算`)
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.branches.length ? { branches: ratingStore.filter.branches.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

onMounted(async () => {
  if (stationStore.stations.length === 0) {
    const { initDatabase } = await import('@/utils/db')
    await initDatabase()
  }
  const query = route.query
  const queryStations = typeof query.stations === 'string' ? query.stations.split(',') : []
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: queryStations,
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    branches:
      typeof query.branches === 'string'
        ? (query.branches.split(',').filter((item) => RATING_BRANCHES.includes(item as RatingBranch)) as RatingBranch[])
        : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : []
  })
  const preferredStation = queryStations[0] ?? stationStore.currentStationId ?? stationStore.stations[0]?.id
  if (preferredStation) {
    ratingStore.setActiveStation(preferredStation)
    const preferredLine = ratingStore.groups.find((group) => group.stationId === preferredStation)?.lineNo ?? 'A'
    ratingStore.setActiveLine(preferredLine)
  }
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与绳套曲线定线</h2>
        <p class="gb-hint">
          同一基础定线号按巡测标记拆成涨水支、落水支分别拟合；残差和比测偏差均按点据所在支线计算。
        </p>
      </div>
      <div class="page__actions">
        <el-select :model-value="stationId" class="page__station-select" @change="handleStationChange">
          <el-option v-for="option in stationOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-select :model-value="lineNo" class="page__line-select" @change="handleLineChange">
          <el-option v-for="value in lineOptions" :key="value" :label="`${value} 线`" :value="value" />
        </el-select>
        <el-radio-group :model-value="branch" size="default" @change="handleBranchChange">
          <el-radio-button v-for="item in RATING_BRANCHES" :key="item" :value="item">{{ item }}支</el-radio-button>
        </el-radio-group>
        <el-button :icon="Refresh" :disabled="ratingStore.isViewingHistorical" @click="refit">重新拟合</el-button>
        <el-button type="success" :icon="Promotion" :disabled="!ratingStore.draftVersion" @click="publish">发布新版</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增点据</el-button>
      </div>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationOptions
        },
        { key: 'lineNos', label: '定线号', options: lineOptions.map((value) => ({ label: `${value} 线`, value })) },
        {
          key: 'branches',
          label: '支线',
          options: RATING_BRANCHES.map((item) => ({ label: `${item}支`, value: item }))
        },
        {
          key: 'verdicts',
          label: '判定',
          options: [
            { label: '合格', value: '合格' },
            { label: '超限', value: '超限' }
          ]
        }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <el-card v-if="pendingRows.length > 0" shadow="never" class="page__pending-card">
      <div class="gb-panel-title">
        <h3><el-icon><Warning /></el-icon> 待人工判定涨落的点据（{{ pendingRows.length }}）</h3>
        <span class="gb-hint">升级时按测流时间无法分出来的点据不参与两支拟合，请资料室逐点确认。</span>
      </div>
      <el-table :data="pendingRows" border size="small" class="gb-table-compact">
        <el-table-column label="测站 / 定线" min-width="170">
          <template #default="{ row }">
            <div>{{ ratingStore.stationNameOf(row.stationId) }}</div>
            <div class="gb-hint">{{ row.lineNo }} 线 · {{ row.measureNo || '未填测次号' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="水位 / 流量" min-width="150">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }} m / {{ row.flowM3s.toFixed(1) }} m³/s</span>
          </template>
        </el-table-column>
        <el-table-column label="归入支线" width="220">
          <template #default="{ row }">
            <el-radio-group :model-value="row.stageTrend" size="small" @change="(value: StageTrend) => resolvePendingTrend(row, value)">
              <el-radio-button v-for="item in RATING_BRANCHES" :key="item" :value="item">{{ item }}</el-radio-button>
            </el-radio-group>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <div class="gb-stats-row">
      <StatBadge :label="`${branch}支点据`" :value="pointRows.length" suffix="点" icon="DataLine" />
      <StatBadge
        label="定线系数 a"
        :value="fit.valid ? fit.a : '—'"
        :suffix="fit.valid ? `b=${fit.b}` : '未定线'"
        tone="info"
        icon="TrendCharts"
      />
      <StatBadge
        label="平均残差"
        :value="fit.valid ? fit.meanResidualPct : '—'"
        suffix="%"
        :tone="fit.valid && fit.meanResidualPct <= ratingStore.deviationLimitPct ? 'success' : 'warning'"
        icon="Histogram"
      />
      <StatBadge
        label="超限点据"
        :value="pointRows.filter((row) => row.verdict === '超限').length"
        suffix="点"
        :tone="pointRows.some((row) => row.verdict === '超限') ? 'danger' : 'success'"
        :icon="pointRows.some((row) => row.verdict === '超限') ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <el-alert
      v-if="activeVersion"
      :type="ratingStore.isViewingHistorical ? 'warning' : activeVersion.status === 'published' ? 'success' : 'info'"
      show-icon
      :closable="false"
      class="page__version-alert"
    >
      <template #title>
        <div class="page__version-line">
          <span>
            当前查看：{{ lineNo }} 线 v{{ activeVersion.versionNo }} · {{ versionStatusText[activeVersion.status] }}
            <template v-if="activeVersion.publishedAt">
              ；发布时间 {{ new Date(activeVersion.publishedAt).toLocaleString('zh-CN') }}
            </template>
          </span>
          <el-button
            v-if="ratingStore.isViewingHistorical"
            text
            type="primary"
            size="small"
            :icon="Back"
            @click="backToCurrent"
          >
            返回当前草稿 / 最新版
          </el-button>
        </div>
      </template>
      <template #default>
        {{ activeVersion.note }}。重新拟合只会产生新草稿；发布后才形成封存新版。
      </template>
    </el-alert>

    <div class="page__version-bar">
      <span class="gb-hint">查看版本：</span>
      <el-select
        :model-value="activeVersion?.id ?? ''"
        class="page__version-select"
        placeholder="暂无版本，重算后生成草稿"
        @change="handleVersionChange"
      >
        <el-option v-for="option in versionOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
      <span class="gb-hint">版本切换只改变展示与历史核查，不会改动封存数据。</span>
    </div>

    <el-alert
      v-if="!fit.valid"
      type="warning"
      show-icon
      :closable="false"
      :title="fit.message || '当前支线下点据不足，至少需要 3 个实测点才能定线'"
    />
    <el-alert
      v-else
      type="success"
      show-icon
      :closable="false"
      :title="`${branchFitLabel(lineNo, branch)} v${activeVersion?.versionNo ?? '-'}：Q = ${fit.a} × (H - ${fit.h0})^${fit.b}；样本 ${fit.sampleCount} 点，平均残差 ${fit.meanResidualPct}%，最大残差 ${fit.maxResidualPct}%`"
    />

    <div class="page__grid">
      <EmptyPanel
        v-if="pointRows.length === 0"
        :title="`该定线号下还没有${branch}支关系点据`"
        description="请先在测次上标记涨落，或将待判点据归入对应支线；待判点不会参与拟合。"
        action-text="新增点据"
        @action="openCreate"
      />

      <el-table v-else :data="pointRows" border stripe class="gb-table-compact">
        <el-table-column label="支线" width="86" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.branch === '涨水' ? 'success' : 'warning'" effect="plain">{{ row.branch }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="105" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.measuredFlow.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.curveFlowM3s > 0 ? row.curveFlowM3s.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差 / 比测" width="200">
          <template #default="{ row }">
            <DeviationTag :deviation-pct="row.residualPct" :verdict="row.verdict" :limit="ratingStore.deviationLimitPct" />
          </template>
        </el-table-column>
        <el-table-column label="测站 / 测次" min-width="170">
          <template #default="{ row }">
            <div>{{ row.stationName }}</div>
            <div class="gb-hint gb-mono">{{ row.rating?.measureNo || '历史点据' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="150">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating ? new Date(row.rating.measuredAt).toLocaleDateString('zh-CN') : '历史快照' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" :disabled="!row.rating || ratingStore.isViewingHistorical" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" :disabled="!row.rating || ratingStore.isViewingHistorical" @click="removeRating(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ lineNo }} 线{{ branch }}支关系曲线</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <polyline v-if="fit.valid" :points="chart.samples" fill="none" :stroke="branchColor" stroke-width="2.5" />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="point.verdict === '超限' ? '#c0392b' : branch === '涨水' ? '#7fd1e8' : '#f5c16c'"
            :stroke="point.verdict === '超限' ? '#7b241c' : branchColor"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="点据归入涨水或落水支后自动生成支线曲线。" compact />
        <p class="gb-hint">红点表示该支线残差超限；蓝、橙分别表示涨水支与落水支。</p>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑关系点据' : '新增关系点据'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="涨落支线" required>
          <el-radio-group v-model="form.stageTrend">
            <el-radio-button value="涨水">涨水</el-radio-button>
            <el-radio-button value="落水">落水</el-radio-button>
            <el-radio-button value="待判">待判</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="流量" required>
          <el-input-number v-model="form.flowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="测次号">
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="点据时间">
          <el-date-picker v-model="form.measuredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并重算' : '新增并定线' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.page__station-select {
  width: 150px;
}

.page__line-select,
.page__version-select {
  width: 120px;
}

.page__version-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #fff;
  border: 1px solid #d8e4ec;
  border-radius: 10px;
}

.page__version-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.page__pending-card {
  border-color: #e6a23c;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 240px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
