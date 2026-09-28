import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Execute the same prepared import as the Worker without bootstrapping demo
// data or depending on a Cloudflare runtime. No input code is accepted here.
const root = new URL('../../', import.meta.url);
const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const transpile = async file => ts.transpileModule(await readFile(new URL(file, root), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
let source = await transpile('app/lib/server/beeline-import.ts');
for (const [alias, file] of Object.entries({ '@/app/admin/role-data': 'app/admin/role-data.ts', '@/app/lib/planned-duration': 'app/lib/planned-duration.ts' })) {
  source = source.replace(`from "${alias}"`, `from "${dataUrl(await transpile(file))}"`);
}
export const manifest = JSON.parse(await readFile(new URL('data/beeline-import.json', root), 'utf8'));
source = source.replace('from "@/data/beeline-import.json"', `from "${dataUrl(`export default ${JSON.stringify(manifest)};`)}"`);
export const { importBeelineIntoEmptyDatabase, beelinePreview } = await import(dataUrl(source));
