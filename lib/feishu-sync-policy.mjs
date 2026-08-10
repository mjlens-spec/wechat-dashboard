export function resolveFeishuSyncCompletion({ truncated, attemptedAt, previousSuccessAt }) {
  if (truncated) {
    return {
      complete: false,
      errorCode: 'FEISHU_RESULT_TRUNCATED',
      lastSuccessAt: previousSuccessAt,
    };
  }
  return {
    complete: true,
    errorCode: null,
    lastSuccessAt: attemptedAt,
  };
}
