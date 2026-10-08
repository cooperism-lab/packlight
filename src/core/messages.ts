// Lines the CLI and the report both show, word for word (design DR8): one source so they never drift.

export const APPLY_COMMAND = 'npx packlight apply';
export const REPORT_COMMAND = 'npx packlight report';

export const MESSAGES = {
  picksSaved: 'Picks saved to your downloads folder. Nothing has changed yet.',
  stepApply: `Run \`${APPLY_COMMAND}\` to archive what you marked.`,
  stepReport: `Then run \`${REPORT_COMMAND}\` to see the result.`,
  afterScan: 'Mark what to archive in the report, press Save my picks, then run the command it shows.',
} as const;
