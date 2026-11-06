import type { LaunchInput } from "@/lib/launch";
import type { StepErrors, WizardState } from "@/lib/launch-steps";

/** What every wizard step receives from the wizard. */
export interface StepProps {
  state: WizardState;
  /** All errors of this step (shown only for fields the visitor touched, or after a failed Next). */
  errors: StepErrors;
  /** The error to show for a field now, if any. */
  err(field: string): string | undefined;
  touch(field: string): void;
  patch(change: Partial<WizardState>): void;
  setInput(change: Partial<LaunchInput>): void;
}
