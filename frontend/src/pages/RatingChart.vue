<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与定线
 * 点据按（定线号 + 涨落标记）分成两支分别幂函数拟合 Q = a×(H-H0)^b，
 * 残差与比测偏差按所在支线计算；定线发布留住当时版本与比测结论。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, TrendCharts, Upload } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import RiseFallTag from '@/components/common/RiseFallTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import { fitPowerCurve, type Rating, type RatingFitResult } from '@/types/rating'
import { RISE_FALLS, RISE_FALL_LABELS, riseFallLabelOf, type RiseFall } from '@/types/section'
import { initDatabase } from '@/utils/db'

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
  riseFall: null as RiseFall | null,
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))

/** 当前定线号下的支线拟合结果 */
const branchFits = computed(() => ratingStore.activeBranchFits)

/** 当前定线号下的点据（按涨落分支线，含曲线流量与残差） */
const pointRows = computed(() => ratingStore.pointRows)

/** 按支线分组的点据（用于绘制两条曲线） */
const branchGroups = computed(() => {
  const groups = new Map<RiseFall | null, typeof pointRows.value>()
  pointRows.value.forEach((row) => {
    const key = row.rating.riseFall
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  })
  return Array.from(groups.entries()).map(([riseFall, rows]) => ({
    riseFall,
    rows: rows.sort((a, b) => a.rating.stageM - b.rating.stageM),
    fit: branchFits.value.find((fit) => fit.riseFall === riseFall) ?? null
  }))
})

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts
}))

/** 关系曲线坐标：横轴水位、纵轴流量；两条支线各一条曲线 */
const chart = computed(() => {
  const rows = pointRows.value
  if (rows.length === 0) {
    return {
      branches: [] as Array<{ riseFall: RiseFall | null; samples: string; color: string }>,
      points: [] as Array<{ id: string; cx: number; cy: number; verdict: string; riseFall: RiseFall | null }>,
      stageMin: 0,
      stageMax: 0,
      flowMax: 0
    }
  }
  const stages = rows.map((row) => row.rating.stageM)
  const flows = rows.map((row) => row.rating.flowM3s)
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

  const branchColors: Record<string, string> = { rising: '#c0392b', falling: '#0f4c75', null: '#7f8c8d' }
  const branches = branchGroups.value
    .filter((group) => group.fit?.valid)
    .map((group) => {
      const samples = Array.from({ length: sampleCount }, (_, index) => {
        const stageM = stageMin + ((stageMax - stageMin) * index) / (sampleCount - 1 || 1)
        const value = group.fit!.a * Math.pow(Math.max(stageM - group.fit!.h0, 1e-6), group.fit!.b)
        return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
      }).join(' ')
      return { riseFall: group.riseFall, samples, color: branchColors[group.riseFall ?? 'null'] }
    })

  return {
    branches,
    points: rows.map((row) => ({
      id: row.rating.id,
      cx: toX(row.rating.stageM),
      cy: toY(row.rating.flowM3s),
      verdict: row.verdict,
      riseFall: row.rating.riseFall
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

/** 当前定线号的已发布版本 */
const versions = computed(() => ratingStore.versionsOfLine(ratingStore.activeLineNo))

function openCreate(): void {
  editingId.value = null
  form.stationId = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
  form.lineNo = ratingStore.activeLineNo
  const last = pointRows.value[pointRows.value.length - 1]
  form.stageM = last ? Number((last.rating.stageM + 0.2).toFixed(2)) : 3
  form.flowM3s = last ? Number((last.rating.flowM3s * 1.2).toFixed(1)) : 50
  form.riseFall = null
  form.measureNo = `${new Date().getFullYear()}-${String(ratingStore.ratings.length + 1).padStart(3, '0')}`
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.riseFall = rating.riseFall
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
      riseFall: form.riseFall,
      measureNo: form.measureNo.trim(),
      measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString()
    }
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('点据已更新')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success('点据已新增，正在重算支线')
    }
    ratingStore.setActiveLine(payload.lineNo)
    dialogVisible.value = false
    await ratingStore.rebuildCompares(payload.lineNo)
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除水位 ${rating.stageM.toFixed(2)} m 处的点据将同时删除其比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  await ratingStore.rebuildCompares(rating.lineNo)
  ElMessage.success('点据已删除并重算支线')
}

async function refit(): Promise<void> {
  const count = await ratingStore.rebuildCompares(ratingStore.activeLineNo)
  const validCount = branchFits.value.filter((fit) => fit.valid).length
  if (validCount > 0) {
    ElMessage.success(`支线重算完成：${validCount} 条支线定线有效，刷新比测 ${count} 条`)
  } else {
    ElMessage.warning('当前点据不足以定线（每支线至少 3 个实测点）')
  }
}

async function publish(): Promise<void> {
  const validCount = branchFits.value.filter((fit) => fit.valid).length
  if (validCount === 0) {
    ElMessage.warning('当前没有可发布的定线成果，请先完成支线定线')
    return
  }
  try {
    const { value: note } = await ElMessageBox.prompt('请填写发布说明（可选）', `发布 ${ratingStore.activeLineNo} 线定线`, {
      confirmButtonText: '发布新版本',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '如：2024 年洪水期绳套曲线定线成果'
    })
    const version = await ratingStore.publishVersion(ratingStore.activeLineNo, note ?? '')
    ElMessage.success(`已发布 v${version.version}，留住 ${version.fits.length} 条支线与 ${version.compares.length} 条比测结论`)
  } catch {
    // 用户取消
  }
}

async function removeVersion(versionId: string, versionNumber: number): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除 v${versionNumber} 发布版本？删除后不可恢复（不影响点据与比测记录）。`,
      '删除版本确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeVersion(versionId)
  ElMessage.success('发布版本已删除')
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
  void ratingStore.rebuildCompares(String(lineNo))
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  const query = route.query
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : []
  })
  void ratingStore.rebuildCompares(ratingStore.activeLineNo)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与定线</h2>
        <p class="gb-hint">
          点据按涨落标记分成两支分别幂函数拟合 Q = a×(H-H0)^b，残差与比测偏差按所在支线计算；定线发布后留住当时版本与比测结论。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="ratingStore.activeLineNo"
          class="page__line-select"
          @change="handleLineChange"
        >
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button :icon="Refresh" @click="refit">重新定线</el-button>
        <el-button type="success" :icon="Upload" @click="publish">发布定线</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增点据</el-button>
      </div>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
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

    <div class="gb-stats-row">
      <StatBadge label="当前线点据" :value="pointRows.length" suffix="点" icon="DataLine" />
      <StatBadge
        v-for="group in branchGroups"
        :key="group.riseFall ?? 'null'"
        :label="`${riseFallLabelOf(group.riseFall)}支`"
        :value="group.fit?.valid ? group.fit.meanResidualPct : '—'"
        suffix="%"
        :tone="group.fit?.valid && group.fit.meanResidualPct <= ratingStore.deviationLimitPct ? 'success' : 'warning'"
        icon="TrendCharts"
      />
      <StatBadge
        label="超限点据"
        :value="pointRows.filter((row) => row.verdict === '超限').length"
        suffix="点"
        :tone="pointRows.some((row) => row.verdict === '超限') ? 'danger' : 'success'"
        icon="WarningFilled"
      />
    </div>

    <el-alert
      v-for="group in branchGroups"
      :key="group.riseFall ?? 'null'"
      :type="group.fit?.valid ? 'success' : 'warning'"
      show-icon
      :closable="false"
      class="page__branch-alert"
      :title="
        group.fit?.valid
          ? `${ratingStore.activeLineNo} 线${riseFallLabelOf(group.riseFall)}支：Q = ${group.fit.a} × (H - ${group.fit.h0})^${group.fit.b}；样本 ${group.fit.sampleCount} 点，平均残差 ${group.fit.meanResidualPct}%，最大残差 ${group.fit.maxResidualPct}%`
          : `${ratingStore.activeLineNo} 线${riseFallLabelOf(group.riseFall)}支：${group.fit?.message ?? '点据不足，至少需要 3 个实测点才能定线'}`
      "
    />

    <div class="page__grid">
      <EmptyPanel
        v-if="pointRows.length === 0"
        title="该定线号下还没有关系点据"
        description="录入实测水位与流量点据后即可按涨落分支做幂函数定线；也可以先切换到其他定线号查看已有成果。"
        action-text="新增点据"
        @action="openCreate"
      />

      <el-table v-else :data="pointRows" border stripe class="gb-table-compact">
        <el-table-column label="涨落" width="90" align="center">
          <template #default="{ row }">
            <RiseFallTag :rise-fall="row.rating.riseFall" />
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量 (m³/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量 (m³/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差" width="200">
          <template #default="{ row }">
            <DeviationTag
              :deviation-pct="row.residualPct"
              :verdict="row.verdict ?? (Math.abs(row.residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格')"
              :limit="ratingStore.deviationLimitPct"
            />
          </template>
        </el-table-column>
        <el-table-column label="测站 / 测次" min-width="180">
          <template #default="{ row }">
            <div>{{ row.stationName }}</div>
            <div class="gb-hint gb-mono">{{ row.rating.measureNo || '未标记测次' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.rating.measuredAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.rating)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ ratingStore.activeLineNo }} 线关系曲线（涨水 / 落水两支）</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <polyline
            v-for="branch in chart.branches"
            :key="branch.riseFall ?? 'null'"
            :points="branch.samples"
            fill="none"
            :stroke="branch.color"
            stroke-width="2"
          />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="point.verdict === '超限' ? '#c0392b' : point.riseFall === 'rising' ? '#e74c3c' : point.riseFall === 'falling' ? '#2980b9' : '#7f8c8d'"
            :stroke="point.verdict === '超限' ? '#7b241c' : '#0f4c75'"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="录入点据后自动生成关系曲线。" compact />
        <p class="gb-hint">
          <span class="page__legend-item"><span class="page__legend-dot" style="background:#e74c3c" />涨水支</span>
          <span class="page__legend-item"><span class="page__legend-dot" style="background:#2980b9" />落水支</span>
          红点表示残差超限的点据，曲线为各支线幂函数定线成果。
        </p>
      </el-card>
    </div>

    <el-card v-if="versions.length > 0" shadow="never" class="page__versions">
      <div class="gb-panel-title">
        <h3>已发布版本</h3>
        <span class="gb-hint">定线发布后留住当时的支线成果与比测结论，重新拟合需再次发布才会刷新</span>
      </div>
      <el-table :data="versions" border size="small" class="gb-table-compact">
        <el-table-column label="版本" width="80" align="center">
          <template #default="{ row }">
            <el-tag size="small" type="success" effect="plain">v{{ row.version }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="发布时间" width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.publishedAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="支线成果" min-width="260">
          <template #default="{ row }">
            <span v-for="fit in row.fits" :key="fit.riseFall ?? 'null'" class="page__version-fit">
              <el-tag size="small" effect="plain" class="page__version-tag">
                {{ riseFallLabelOf(fit.riseFall) }}:
                Q={{ fit.valid ? `${fit.a}·(H-${fit.h0})^${fit.b}` : '未定线' }}
              </el-tag>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="比测结论" width="180">
          <template #default="{ row }">
            <span class="gb-mono">
              {{ row.compareSummary.total }} 点 / 超限 {{ row.compareSummary.overLimit }} / 合格率 {{ row.compareSummary.qualifyRatePct }}%
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="发布说明" min-width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeVersion(row.id, row.version)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

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
        <el-form-item label="涨落标记">
          <el-radio-group v-model="form.riseFall">
            <el-radio-button v-for="riseFall in RISE_FALLS" :key="riseFall" :value="riseFall">
              {{ RISE_FALL_LABELS[riseFall] }}
            </el-radio-button>
            <el-radio-button :value="null">未标记</el-radio-button>
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
  gap: 8px;
}

.page__line-select {
  width: 120px;
}

.page__branch-alert {
  margin: 0;
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

.page__legend-item {
  margin-right: 12px;
}

.page__legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  border-radius: 50%;
  vertical-align: middle;
}

.page__versions {
  border: 1px solid #d8e4ec;
}

.page__version-fit {
  margin-right: 6px;
}

.page__version-tag {
  margin-bottom: 2px;
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
