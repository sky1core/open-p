export interface PtyStartOptions {
  readonly cwd: string;
  readonly sessionName: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly isolateAnthropicEnv?: boolean;
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
