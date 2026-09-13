interface DecimalValue {
  units: bigint;
  scale: number;
}

const TEN = 10n;

function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 10_000) {
    throw new Error("Invalid decimal exponent");
  }
  return TEN ** BigInt(exponent);
}

function normalizeDecimal(value: DecimalValue): DecimalValue {
  let { units, scale } = value;
  while (scale > 0 && units % TEN === 0n) {
    units /= TEN;
    scale -= 1;
  }
  return { units, scale };
}

function parseDecimal(value: string): DecimalValue {
  const input = value.trim();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(input);
  if (!match) {
    throw new Error(`Invalid decimal value: ${value}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const integerPart = match[2] ?? "0";
  const fractionalPart = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) {
    throw new Error(`Invalid decimal exponent: ${value}`);
  }

  let units = BigInt(`${integerPart}${fractionalPart}` || "0") * sign;
  let scale = fractionalPart.length - exponent;
  if (scale < 0) {
    units *= pow10(-scale);
    scale = 0;
  }
  return normalizeDecimal({ units, scale });
}

function formatDecimal(value: DecimalValue): string {
  const normalized = normalizeDecimal(value);
  const negative = normalized.units < 0n;
  const digits = (negative ? -normalized.units : normalized.units).toString();
  if (normalized.scale === 0) {
    return `${negative ? "-" : ""}${digits}`;
  }

  const padded = digits.padStart(normalized.scale + 1, "0");
  const splitAt = padded.length - normalized.scale;
  return `${negative ? "-" : ""}${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
}

function alignDecimals(left: DecimalValue, right: DecimalValue): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.units * pow10(scale - left.scale),
    right.units * pow10(scale - right.scale),
    scale,
  ];
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export function normalizeDecimalString(value: string): string {
  return formatDecimal(parseDecimal(value));
}

export function compareDecimalStrings(left: string, right: string): number {
  const [leftUnits, rightUnits] = alignDecimals(parseDecimal(left), parseDecimal(right));
  if (leftUnits < rightUnits) return -1;
  if (leftUnits > rightUnits) return 1;
  return 0;
}

export function multiplyDecimalStrings(left: string, right: string): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  return formatDecimal({ units: a.units * b.units, scale: a.scale + b.scale });
}

export function addDecimalStrings(left: string, right: string): string {
  const [leftUnits, rightUnits, scale] = alignDecimals(parseDecimal(left), parseDecimal(right));
  return formatDecimal({ units: leftUnits + rightUnits, scale });
}

export function floorDecimalToStep(value: string, step: string): string {
  const parsedValue = parseDecimal(value);
  const parsedStep = parseDecimal(step);
  if (parsedValue.units < 0n || parsedStep.units <= 0n) {
    throw new Error("Decimal step rounding requires a non-negative value and positive step");
  }

  const [valueUnits, stepUnits, scale] = alignDecimals(parsedValue, parsedStep);
  return formatDecimal({ units: (valueUnits / stepUnits) * stepUnits, scale });
}

export function ceilDecimalRatioToStep(
  target: string,
  divisor: string,
  step: string,
): string {
  const parsedTarget = parseDecimal(target);
  const parsedDivisor = parseDecimal(divisor);
  const parsedStep = parseDecimal(step);
  if (parsedTarget.units < 0n || parsedDivisor.units <= 0n || parsedStep.units <= 0n) {
    throw new Error("Decimal ratio rounding requires non-negative target and positive divisor/step");
  }
  if (parsedTarget.units === 0n) return "0";

  const numerator = parsedTarget.units * pow10(parsedDivisor.scale + parsedStep.scale);
  const denominator =
    parsedDivisor.units * parsedStep.units * pow10(parsedTarget.scale);
  const stepCount = (numerator + denominator - 1n) / denominator;
  return formatDecimal({ units: stepCount * parsedStep.units, scale: parsedStep.scale });
}

export function combineDecimalSteps(steps: string[]): string | undefined {
  const enabled = steps
    .map((step) => parseDecimal(step))
    .filter((step) => step.units > 0n);
  if (enabled.length === 0) return undefined;

  const scale = Math.max(...enabled.map((step) => step.scale));
  let combined = 1n;
  for (const step of enabled) {
    const units = step.units * pow10(scale - step.scale);
    combined = (combined / greatestCommonDivisor(combined, units)) * units;
  }
  return formatDecimal({ units: combined, scale });
}
