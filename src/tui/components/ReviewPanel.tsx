import { Box, Text } from 'ink';
import React, { type ReactElement } from 'react';

import type { ReviewFinding, ReviewResult } from '../../app/review/ReviewRunner.js';

export function ReviewPanel({ data }: { data: unknown }): ReactElement {
  if (!isReviewResult(data)) {
    return (
      <Box flexDirection="column" marginY={1} paddingLeft={2}>
        <Text color="yellow">Review result is unavailable.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2}>
      <Text color="blue">Review result · {data.target.kind} · {data.target.diffHash.slice(0, 12)}</Text>
      <Text>{data.summary}</Text>
      {data.findings.length === 0 ? <Text color="gray">No reportable findings.</Text> : null}
      {data.findings.map((finding, index) => (
        <Text key={`${finding.file}:${finding.line ?? 0}:${index}`} wrap="wrap">
          <Text color={severityColor(finding.severity)}>[{finding.severity}]</Text>
          {' '}{finding.file}{finding.line === undefined ? '' : `:${finding.line}`} · {finding.title} — {finding.scenario}
        </Text>
      ))}
    </Box>
  );
}

function isReviewResult(value: unknown): value is ReviewResult {
  return typeof value === 'object' &&
    value !== null &&
    'target' in value &&
    typeof value.target === 'object' &&
    value.target !== null &&
    'diffHash' in value.target &&
    typeof value.target.diffHash === 'string' &&
    'findings' in value &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding) &&
    'summary' in value &&
    typeof value.summary === 'string';
}

function isFinding(value: unknown): value is ReviewFinding {
  return typeof value === 'object' && value !== null &&
    'severity' in value && typeof value.severity === 'string' &&
    'file' in value && typeof value.file === 'string' &&
    'title' in value && typeof value.title === 'string' &&
    'scenario' in value && typeof value.scenario === 'string';
}

function severityColor(severity: ReviewFinding['severity']): 'red' | 'yellow' | 'cyan' {
  if (severity === 'critical' || severity === 'high') return 'red';
  return severity === 'medium' ? 'yellow' : 'cyan';
}
