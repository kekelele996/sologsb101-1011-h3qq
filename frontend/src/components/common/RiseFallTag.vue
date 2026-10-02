<script setup lang="ts">
/**
 * <RiseFallTag> 涨落标记标签：涨水（红）/ 落水（蓝）/ 未标记（灰）。
 * 被断面列表、关系点据页、导出页消费。
 */
import { computed } from 'vue'
import { RISE_FALL_LABELS, RISE_FALL_TAG_TYPES, type RiseFall } from '@/types/section'

const props = withDefaults(
  defineProps<{
    /** 涨落标记；为空显示「未标记」 */
    riseFall: RiseFall | null
    /** 标签尺寸 */
    size?: 'default' | 'small' | 'large'
    /** 是否显示圆点 */
    dot?: boolean
  }>(),
  {
    size: 'small',
    dot: false
  }
)

const label = computed(() => (props.riseFall ? RISE_FALL_LABELS[props.riseFall] : '未标记'))
const type = computed(() => (props.riseFall ? RISE_FALL_TAG_TYPES[props.riseFall] : 'info'))
</script>

<template>
  <el-tag :size="size" :type="type" effect="plain" round>
    <span v-if="dot" class="rise-fall-tag__dot" :class="`is-${riseFall ?? 'none'}`" />
    {{ label }}
  </el-tag>
</template>

<style scoped>
.rise-fall-tag__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: 50%;
  vertical-align: middle;
}

.rise-fall-tag__dot.is-rising {
  background: #c0392b;
}

.rise-fall-tag__dot.is-falling {
  background: #0f4c75;
}

.rise-fall-tag__dot.is-none {
  background: #909399;
}
</style>
