import {} from 'lit/html';
import { runInAction, observable, observe, makeObservable } from 'mobx';
import * as utils from '../utils';
import * as constants from './constants';
import './simple-icon-element';
import { Track } from './schema';
import { Database } from './database';
import { EvalParams, createEvaluator } from './code-eval';
import { getHandleFromAbsPath } from './paths';

export interface TranscodeInput {
  track: Track;
  codeInputs: EvalParams;
}

export enum FileStatus {
  CanCreate,
  ExistsCanOverwrite,
  ExistsCannotOverwrite,
}

export interface TranscodeOutput {
  input: Track;
  inputAbsFilePath: string;
  error?: string;
  outputFilePath?: string;
  outputAbsFilePath?: string;
  outputFileStatus?: FileStatus;
  userOptions: TranscodeTrackOptions;
}

export enum UserConfirmationState {
  Default,
  Accepted,
  Rejected,
}

export class TranscodeTrackOptions {
  @observable userConfirmation = UserConfirmationState.Default;
  @observable isComplete = false;
  @observable isError = false;
  @observable completionFraction = 0;

  constructor() {
    makeObservable(this);
  }
}

export class TranscodeOperation {
  @observable code: string = '';
  readonly inputs: TranscodeInput[];
  @observable error: string|null = null;
  @observable.shallow outputs: TranscodeOutput[] = [];

  private updateCodeEpoch = 0;
  private readonly updateQueue = new utils.OperationQueue();

  @observable isLaunched = false;
  @observable isComplete = false;
  @observable completionFraction = 0;

  constructor(public readonly inputTracks: Track[]) {
    makeObservable(this);
    observe(this, 'code', this.updateOutputs.bind(this));

    let listIndex = 0;
    let listCount = this.inputTracks.length;
    this.inputs = this.inputTracks.map(track => {
      const inputAbsFilePath = Database.getAbsPathFilePath(track.filePath);
      const input: EvalParams = {
        'listIndex': listIndex++,
        'listCount': listCount,
        'fileExt': utils.filePathExtension(inputAbsFilePath),
        'fileNameNoExt': utils.filePathFileNameWithoutExtension(inputAbsFilePath),
        'fileName': utils.filePathFileName(inputAbsFilePath),
        'directory': utils.filePathDirectory(inputAbsFilePath),
        'path': inputAbsFilePath,
        'track': track,
      };
      return {track: track, codeInputs: input};
    });
  }

  private updateOutputs() {
    if (this.isLaunched) {
      return;
    }

    const thisEpoch = ++this.updateCodeEpoch;
    setTimeout(() => {
      if (thisEpoch !== this.updateCodeEpoch) {
        return;
      }
      this.updateQueue.push(() => {
        if (thisEpoch !== this.updateCodeEpoch) {
          return;
        }
        this.doUpdateOutputs();
      });
    }, 0);
  }

  private async doUpdateOutputs() {
    if (this.isLaunched) {
      return;
    }

    let error: string|null = null;
    const results: TranscodeOutput[] = [];

    const compileResult = createEvaluator(this.code);
    if (compileResult.error) {
      error = compileResult.error;
    } else {
      for (const input of this.inputs) {
        let localError: string|undefined;
        const track = input.track;
        const inputAbsFilePath = Database.getAbsPathFilePath(track.filePath);
        const output: TranscodeOutput = {
          input: track,
          inputAbsFilePath: inputAbsFilePath,
          userOptions: new TranscodeTrackOptions(),
        };
        try {
          const result = compileResult.func?.(input.codeInputs)!;
          if (result.error) {
            localError = result.error;
          } else if (typeof result.value === 'string') {
            const outputFilePath: string = result.value;
            const outputAbsFilePath = utils.filePathResolveAbsPath(outputFilePath, utils.filePathDirectory(inputAbsFilePath));
            output.outputFilePath = outputFilePath;
            output.outputAbsFilePath = outputAbsFilePath;
            const fileHandle = await getHandleFromAbsPath(outputAbsFilePath);
            let fileStatus: FileStatus;
            if (fileHandle?.kind === 'directory') {
              fileStatus = FileStatus.ExistsCannotOverwrite;
            } else if (fileHandle?.kind === 'file') {
              fileStatus = FileStatus.ExistsCanOverwrite;
            } else {
              fileStatus = FileStatus.CanCreate;
            }
            output.outputFileStatus = fileStatus;
          }
          // TODO: Improve heuristic.
          await utils.sleep(0);
        } catch (e) {
          localError = e?.toString() ?? 'unknown error';
        }
        output.error = localError;
        results.push(output);
      }
    }
    runInAction(() => {
      this.error = error;
      this.outputs = results;
    });
  }

  launchJob() {
    if (this.isLaunched) {
      return;
    }
    this.isLaunched = true;

    const toLaunch = this.outputs.filter(output =>
        output.userOptions.userConfirmation === UserConfirmationState.Accepted ||
        output.userOptions.userConfirmation === UserConfirmationState.Default && output.outputFileStatus === FileStatus.CanCreate);
    if (toLaunch.length === 0) {
      runInAction(() => {
        this.isComplete = true;
        this.completionFraction = 1.0;
      });
      return;
    }

    (async () => {
      const updateTotalState = () => {
        let totalCompletion = 0;
        for (const toProcess of toLaunch) {
          totalCompletion += toProcess.userOptions.completionFraction;
        }
        this.completionFraction = totalCompletion / toLaunch.length;
      };

      const queue = new utils.AsyncProducerConsumerQueue<TranscodeOutput>();
      const workers = [];
      for (let i = 0; i < constants.TRANSCODE_WORKER_COUNT; ++i) {
        workers.push((async () => {
          while (true) {
            const toProcess = await queue.popOrTerminate();
            if (toProcess === undefined) {
              // Terminated.
              return;
            }
            let isError = false;
            try {
              while (true) {
                await utils.sleep(100);
                const newFraction = toProcess.userOptions.completionFraction + Math.random() * 0.1 + 0.1;
                if (Math.random() < 0.05) {
                  throw new Error('Fake error!!!');
                }
                if (newFraction > 1) {
                  break;
                }
                runInAction(() => {
                  toProcess.userOptions.completionFraction = newFraction;
                  updateTotalState();
                });
              }
            } catch (e) {
              console.error(e);
              isError = true;
            }
            runInAction(() => {
              toProcess.userOptions.completionFraction = 1;
              toProcess.userOptions.isComplete = true;
              toProcess.userOptions.isError = isError;
              updateTotalState();
            });
          }
        })());
      }
      queue.addRange(toLaunch);
      await queue.join();
      queue.terminate();
      await Promise.all(workers);
      runInAction(() => {
        this.completionFraction = 1.0;
        this.isComplete = true;
      });
    })();
  }
}
