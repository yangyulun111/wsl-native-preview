import { readHookInput, runHook } from "./hook-runtime.mjs";

const event = process.argv[2] ?? "";

try {
  const input = await readHookInput();
  const output = runHook(event, input, {
    onError: (error) => process.stderr.write(`wsl-native-preview hook warning: ${JSON.stringify(error)}\n`),
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`wsl-native-preview hook failed safely: ${error?.message ?? String(error)}\n`);
  process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true })}\n`);
}
