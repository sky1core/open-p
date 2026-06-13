export interface PtyStartOptions {
  readonly cwd: string;
  readonly sessionName: string;
  readonly env?: Readonly<Record<string, string>>;
  // Ambient env keys whose name starts with any of these prefixes are removed from the child
  // environment. The concrete prefixes are backend-owned (a backend that isolates provider env
  // injects them at launch); core/runners stay backend-neutral and do not hardcode any provider name.
  readonly isolateEnvPrefixes?: readonly string[];
  readonly unsetEnv?: readonly string[];
}

export interface PtySession {
  readonly id: string;
  write(input: string): Promise<void>;
  submit(): Promise<void>;
  interrupt(): Promise<void>;
  terminate(signal?: NodeJS.Signals): Promise<void>;
  exit(): Promise<void>;
  isAlive(): Promise<boolean>;
  captureText(): Promise<string>;
  captureCursorLine(): Promise<string>;
}

export interface PtyProvider {
  start(command: string, args: readonly string[], options: PtyStartOptions): Promise<PtySession>;
}
