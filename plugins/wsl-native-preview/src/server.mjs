import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WslPreviewBridge, publicError } from "./core.mjs";

const bridge = new WslPreviewBridge();
const server = new McpServer({ name: "wsl-native-preview", version: "0.2.0" });
const registeredResourceUris = new Set();
const resourceRegistry = new Map();

function textResult(action) {
  try {
    const value = action();
    return {
      value,
      result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] },
    };
  } catch (error) {
    return {
      value: null,
      result: {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(publicError(error), null, 2) }],
      },
    };
  }
}

server.registerResource(
  "wsl-native-preview-about",
  "wsl-preview://about",
  {
    title: "WSL Native Preview resource service",
    description: "ResourceLink probe endpoint for the target Codex Desktop build.",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: "WSL Native Preview resource service is available." }],
  }),
);

function registerProbeResource(contextId, artifact, candidate) {
  const normalizedUri = new URL(candidate.uri).href;
  resourceRegistry.set(normalizedUri, {
    contextId,
    canonicalFile: artifact.canonicalLinuxPath,
    mimeType: candidate.mimeType,
  });
  if (registeredResourceUris.has(normalizedUri)) return;
  registeredResourceUris.add(normalizedUri);
  const resourceName = `wsl-preview-${crypto.createHash("sha256").update(normalizedUri).digest("hex").slice(0, 20)}`;
  server.registerResource(
    resourceName,
    normalizedUri,
    {
      title: candidate.title,
      description: candidate.description,
      mimeType: candidate.mimeType,
    },
    async (uri) => {
      const record = resourceRegistry.get(uri.href);
      if (!record) throw new Error("The preview resource is no longer registered in this MCP process.");
      return bridge.readPreparedResource({ ...record, uri: uri.href });
    },
  );
}

server.registerTool(
  "wsl_preview_status",
  {
    title: "WSL preview status",
    description: "Read hook context, plugin ownership, QueryDosDeviceW, and candidate drive state without starting a distro or changing mappings.",
    inputSchema: {
      contextId: z.string().min(1).optional().describe("Short-lived contextId injected by the trusted SessionStart hook."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => textResult(() => bridge.status(args)).result,
);

server.registerTool(
  "prepare_preview_artifacts",
  {
    title: "Prepare WSL preview artifacts",
    description: "Validate files against a trusted hook-created workspace context, ensure one scoped drive alias, and return Desktop preview Markdown.",
    inputSchema: {
      contextId: z.string().min(1).describe("Short-lived contextId injected by the trusted SessionStart hook."),
      paths: z.array(z.string().min(1)).min(1).max(20).describe("Absolute Linux file paths inside the trusted workspace."),
      probeResourceLinks: z.boolean().optional().describe("Return three experimental ResourceLink variants for an explicit UI gate. Defaults to false."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    const call = textResult(() => bridge.preparePreviewArtifacts(args));
    if (!call.value || !args.probeResourceLinks) return call.result;
    for (const artifact of call.value.artifacts) {
      for (const candidate of artifact.resourceLinkCandidates ?? []) {
        registerProbeResource(call.value.contextId, artifact, candidate);
        call.result.content.push({
          type: "resource_link",
          name: candidate.name,
          title: candidate.title,
          uri: candidate.uri,
          description: `${candidate.variant}: ${candidate.description}`,
          mimeType: candidate.mimeType,
          ...(Number.isSafeInteger(artifact.size) ? { size: artifact.size } : {}),
        });
      }
    }
    return call.result;
  },
);

server.registerTool(
  "release_preview_mapping",
  {
    title: "Release current WSL preview mapping",
    description: "Remove only the exact plugin-owned mapping bound to a trusted context; changed or unrelated drives are never removed.",
    inputSchema: {
      contextId: z.string().min(1).describe("Short-lived contextId injected by the trusted SessionStart hook."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (args) => textResult(() => bridge.releasePreviewMappingForContext(args)).result,
);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (error) {
  process.stderr.write(`wsl-native-preview MCP startup failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
}
