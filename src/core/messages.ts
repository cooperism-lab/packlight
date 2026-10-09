// Lines the CLI and the report both show, word for word (design DR8): one source so they never drift.

/**
 * How to call packlight again: "npx packlight" when this run came through npx, plain "packlight" when it is
 * installed (npm link or a global install). Until packlight is on npm, npx can only find a local install.
 */
export const INVOKE = process.env.npm_command === 'exec' ? 'npx packlight' : 'packlight';

export const APPLY_COMMAND = `${INVOKE} apply`;
export const REPORT_COMMAND = `${INVOKE} report`;
export const PASTE_COMMAND = `${INVOKE} apply --paste`;
export const FIX_COMMAND = `${INVOKE} fix`;

export const MESSAGES = {
  picksSaved: 'Your browser should now have packlight-picks.json in your downloads folder. Nothing has changed yet.',
  noFile: `No file in your downloads? Press Copy picks, then run \`${PASTE_COMMAND}\`.`,
  stepApply: `Run \`${APPLY_COMMAND}\` in your terminal: it shows the plan and asks before it changes anything.`,
  stepReport: `Then run \`${REPORT_COMMAND}\` to see the result.`,
  afterScan: 'Mark what to archive in the report, press Save my picks, then run the command it shows.',
} as const;
