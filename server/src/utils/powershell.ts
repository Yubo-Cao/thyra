export function powershellSingleQuotedString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
