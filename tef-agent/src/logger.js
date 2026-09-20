// Log em uma linha, com nível e timestamp. O journald já registra a hora,
// mas manter o timestamp ajuda quando os logs são copiados para um ticket.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const current = LEVELS[process.env.LOG_LEVEL ?? "info"] ?? LEVELS.info;

function emit(level, message, extra) {
  if (LEVELS[level] > current) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  const target = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) target(line);
  else target(line, extra);
}

export const log = {
  error: (message, extra) => emit("error", message, extra),
  warn: (message, extra) => emit("warn", message, extra),
  info: (message, extra) => emit("info", message, extra),
  debug: (message, extra) => emit("debug", message, extra),
};
