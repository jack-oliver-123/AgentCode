const MIN_SECRET_LENGTH = 8;
const VISIBLE_PREFIX_LENGTH = 4;
const VISIBLE_SUFFIX_LENGTH = 4;

export function redactSecret(secret: string): string {
  if (secret.length === 0) {
    return '<empty>';
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    return '<redacted>';
  }

  return `${secret.slice(0, VISIBLE_PREFIX_LENGTH)}…${secret.slice(-VISIBLE_SUFFIX_LENGTH)}`;
}

export function redactText(text: string, secrets: readonly string[]): string {
  return secrets.reduce((currentText, secret) => {
    if (secret.length === 0) {
      return currentText;
    }

    return currentText.split(secret).join(redactSecret(secret));
  }, text);
}
