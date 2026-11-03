import type { AiOutput } from '~/logic/types'
import { z } from 'zod'

export const expiryFields = {
  validForSeconds: z.union([z.number(), z.string(), z.null()]).optional().catch(null),
  expiresAt: z.union([z.string(), z.number(), z.null()]).optional().catch(null),
}

export const codeDataSchema = z.object({
  value: z.union([z.string(), z.null()]).optional(),
  ...expiryFields,
})

export const confirmDataSchema = z.object({
  url: z.union([z.string(), z.null()]).optional(),
  label: z.union([z.string(), z.null()]).optional(),
  ...expiryFields,
})

export const summaryDataSchema = z.object({
  minimal: z.string().optional().catch(''),
  text: z.string().optional().catch(''),
})

export const customDataSchema = z.object({
  text: z.string().optional().catch(''),
})

export const typeMatchSchema = z.object({
  adapterId: z.string(),
  code: codeDataSchema.optional(),
  confirm: confirmDataSchema.optional(),
  summary: summaryDataSchema.optional(),
  custom: customDataSchema.optional(),
})

export const aiResultSchema = z.object({
  /*
   * `types` 是**必填**（哪怕是空数组）。
   *
   * ⚠ 不能写成 `.catch([])`：模型返回 `{}` 时会被悄悄当成「没有任何类型命中」，
   *   既不会重试也不会降级 —— 用户看到的是一封「处理过但什么也没有」的邮件。
   *   缺字段 = 结构性错误，应该走重试 / 降级。
   */
  types: z.array(typeMatchSchema).max(20),
  states: z.array(z.enum(['ad', 'urgent', 'low'])).max(3).catch([]),
})

export type AiResultSchema = z.infer<typeof aiResultSchema>

/** 一次 AI 分析的结果：邮件级状态位 + 类型命中 */
export interface AiResult {
  output: AiOutput
  stateFlags: number
}
