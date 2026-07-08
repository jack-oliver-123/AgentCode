import type { ProviderToolDeclaration } from '../tools/types.js';

const TOOL_DESCRIPTION_SUFFIXES: ReadonlyMap<string, string> = new Map([
  ['edit_file', '\n\nImportant: 调用前必须先用 read_file 读取目标文件。'],
  ['write_file', '\n\nImportant: 仅用于创建新文件；修改已有文件请用 edit_file。'],
  ['run_command', '\n\nImportant: 如果存在专用工具（read_file/write_file/edit_file/glob_files/search_code）能完成任务，优先使用专用工具而非 run_command。'],
]);

export function enhanceToolDeclarations(
  declarations: ProviderToolDeclaration[]
): ProviderToolDeclaration[] {
  return declarations.map((decl) => {
    const suffix = TOOL_DESCRIPTION_SUFFIXES.get(decl.name);
    if (suffix === undefined) {
      return decl;
    }
    return { ...decl, description: `${decl.description}${suffix}` };
  });
}
