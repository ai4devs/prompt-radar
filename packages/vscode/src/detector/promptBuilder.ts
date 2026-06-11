import * as vscode from "vscode";

// Loads the bundled detector prompt and seed catalog and substitutes the
// {{ARTIFACT}} and {{SEED_CATALOG}} placeholders. Resources are read once and
// cached for the lifetime of the extension host.

interface CatalogEntry {
  id: string;
  name: string;
  signal: string;
  typical_severity: string;
}

let cachedTemplate: string | undefined;
let cachedCatalogBlock: string | undefined;

async function readResource(
  extensionUri: vscode.Uri,
  ...parts: string[]
): Promise<string> {
  const uri = vscode.Uri.joinPath(extensionUri, ...parts);
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Render the catalog as the compact `id — name — signal — typical: sev` lines the prompt expects. */
function renderCatalog(raw: string): string {
  const parsed = JSON.parse(raw) as { smells: CatalogEntry[] };
  return parsed.smells
    .map((e) => `${e.id} — ${e.name} — ${e.signal} — typical: ${e.typical_severity}`)
    .join("\n");
}

/** Build the full detector prompt for a single artifact. */
export async function buildDetectorPrompt(
  extensionUri: vscode.Uri,
  artifact: string
): Promise<string> {
  if (cachedTemplate === undefined) {
    cachedTemplate = await readResource(
      extensionUri,
      "resources",
      "prompts",
      "detector_v1.txt"
    );
  }
  if (cachedCatalogBlock === undefined) {
    const raw = await readResource(
      extensionUri,
      "resources",
      "catalogs",
      "catalog_v1.json"
    );
    cachedCatalogBlock = renderCatalog(raw);
  }

  // Use function replacers so `$` in the artifact/catalog is not treated as a
  // replacement pattern. Each placeholder occurs exactly once.
  const catalog = cachedCatalogBlock;
  return cachedTemplate
    .replace("{{SEED_CATALOG}}", () => catalog)
    .replace("{{ARTIFACT}}", () => artifact);
}
