// Ink's key map carries no home/end flag and blanks `input` for both keys, so
// by the time useInput runs nothing distinguishes Home from End or from any
// other unmapped function key. Rewriting the sequences to their readline
// equivalents upstream of Ink is the only channel that survives.

export const CTRL_A = "\x01";
export const CTRL_E = "\x05";

const HOME_SEQUENCES = ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"];
const END_SEQUENCES = ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"];

export const readlineForNavKey = (sequence: string): string | null => {
    if (HOME_SEQUENCES.includes(sequence)) return CTRL_A;
    if (END_SEQUENCES.includes(sequence)) return CTRL_E;
    return null;
};
