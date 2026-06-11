import { z } from "zod";
import { ARTIFACT_TYPES, DIMENSIONS, SEVERITIES } from "./types";

export const SmellLocationSchema = z.object({
  char_start: z.number().int().min(0),
  char_end: z.number().int().min(0),
  line: z.number().int().nullable(),
});

export const SmellSchema = z.object({
  id: z.string(),
  name: z.string(),
  novel: z.boolean(),
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1),
  description: z.string(),
  rationale: z.string(),
  evidence: z.string(),
  location: SmellLocationSchema,
  remediation: z.string(),
});

export const DimensionResultSchema = z.object({
  dimension: z.enum(DIMENSIONS),
  score: z.number().int().min(1).max(5),
  smells: z.array(SmellSchema),
});

export const DetectorJSONSchema = z.object({
  artifact_type: z.enum(ARTIFACT_TYPES),
  fragments_analyzed: z.number().int().min(0),
  overall_score: z.number(),
  summary: z.string(),
  dimensions: z.array(DimensionResultSchema),
});

export type SmellLocation = z.infer<typeof SmellLocationSchema>;
export type Smell = z.infer<typeof SmellSchema>;
export type DimensionResult = z.infer<typeof DimensionResultSchema>;
export type DetectorJSON = z.infer<typeof DetectorJSONSchema>;
