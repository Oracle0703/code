import type {
  AutomationChangedEvent,
  AutomationCreateInput,
  AutomationSetEnabledInput,
  AutomationSnapshot,
  AutomationTargetInput,
  AutomationUpdateInput,
  WorkspaceTargetInput,
} from '../../shared/contracts';
import { AutomationScheduler, type AutomationSchedulerTimer } from './automation-scheduler';
import type { AutomationRunInput, AutomationRunResult } from './automation-service';
import type { StoredAutomation } from './automation-repository';

export interface AutomationControllerDatabase {
  getAutomationSnapshot(input: WorkspaceTargetInput): Promise<AutomationSnapshot>;
  createAutomation(input: AutomationCreateInput): Promise<AutomationSnapshot>;
  updateAutomation(input: AutomationUpdateInput): Promise<AutomationSnapshot>;
  setAutomationEnabled(input: AutomationSetEnabledInput): Promise<AutomationSnapshot>;
  archiveAutomation(input: AutomationTargetInput): Promise<AutomationSnapshot>;
  readAutomationSchedulerEntries(): Promise<readonly StoredAutomation[]>;
  runAutomationOccurrence(input: AutomationRunInput): Promise<AutomationRunResult>;
}

export interface AutomationControllerOptions {
  readonly database: AutomationControllerDatabase;
  readonly now?: () => Date;
  readonly timer?: AutomationSchedulerTimer;
  readonly maximumWakeDelayMs?: number;
  readonly onChanged?: (event: AutomationChangedEvent) => void;
  readonly onError?: (error: unknown) => void;
}

export class AutomationController {
  readonly #database: AutomationControllerDatabase;
  readonly #scheduler: AutomationScheduler;
  readonly #onChanged: (event: AutomationChangedEvent) => void;
  readonly #onError: (error: unknown) => void;

  constructor({
    database,
    now,
    timer,
    maximumWakeDelayMs,
    onChanged = () => undefined,
    onError = () => undefined,
  }: AutomationControllerOptions) {
    this.#database = database;
    this.#onChanged = onChanged;
    this.#onError = onError;
    this.#scheduler = new AutomationScheduler({
      store: {
        readSchedulerEntries: () => database.readAutomationSchedulerEntries(),
        runOccurrence: (input) => database.runAutomationOccurrence(input),
      },
      onRun: (result) => this.#handleRun(result),
      onError: (error) => this.#safeError(error),
      ...(now ? { now } : {}),
      ...(timer ? { timer } : {}),
      ...(maximumWakeDelayMs !== undefined ? { maximumWakeDelayMs } : {}),
    });
  }

  getSnapshot(input: WorkspaceTargetInput): Promise<AutomationSnapshot> {
    return this.#database.getAutomationSnapshot(input);
  }

  async create(input: AutomationCreateInput): Promise<AutomationSnapshot> {
    const snapshot = await this.#database.createAutomation(input);
    this.#emit({ workspaceId: input.workspaceId, reason: 'definition', outputKind: null });
    void this.evaluate().catch((error) => this.#safeError(error));
    return snapshot;
  }

  async update(input: AutomationUpdateInput): Promise<AutomationSnapshot> {
    const snapshot = await this.#database.updateAutomation(input);
    this.#emit({ workspaceId: input.workspaceId, reason: 'definition', outputKind: null });
    void this.evaluate().catch((error) => this.#safeError(error));
    return snapshot;
  }

  async setEnabled(input: AutomationSetEnabledInput): Promise<AutomationSnapshot> {
    const snapshot = await this.#database.setAutomationEnabled(input);
    this.#emit({ workspaceId: input.workspaceId, reason: 'definition', outputKind: null });
    void this.evaluate().catch((error) => this.#safeError(error));
    return snapshot;
  }

  async archive(input: AutomationTargetInput): Promise<AutomationSnapshot> {
    const snapshot = await this.#database.archiveAutomation(input);
    this.#emit({ workspaceId: input.workspaceId, reason: 'definition', outputKind: null });
    void this.evaluate().catch((error) => this.#safeError(error));
    return snapshot;
  }

  start(): Promise<void> {
    return this.#scheduler.start();
  }

  evaluate(): Promise<void> {
    return this.#scheduler.evaluate();
  }

  stop(): Promise<void> {
    return this.#scheduler.stop();
  }

  #handleRun(result: AutomationRunResult): void {
    if (result.workspaceId === null || result.status === 'skipped') return;
    this.#emit({
      workspaceId: result.workspaceId,
      reason: 'run',
      outputKind: result.outputKind,
    });
  }

  #emit(event: AutomationChangedEvent): void {
    try {
      this.#onChanged(event);
    } catch (error) {
      this.#safeError(error);
    }
  }

  #safeError(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Diagnostics cannot change controller state.
    }
  }
}
