// Reads the input schema a tool declares, as far as a scan needs it: what a
// plain call looks like, where the strings in it are, and what the schema
// says must not be accepted. This is not a JSON Schema validator. It reads
// the keywords servers actually use and leaves the rest alone.

export type ArgumentKind = "path" | "url" | "command" | "text";

export type SchemaNode = Readonly<Record<string, unknown>>;

// The values a plain call is built from.
export type BaseValues = {
  // A file that exists in the server's directory.
  readonly path: string;
  // A directory that exists there.
  readonly dir: string;
  // A name nothing has yet, for an argument that says where to put a result.
  readonly fresh: string;
  // An address that answers.
  readonly url: string;
};

// One place in the arguments where a string goes.
export type StringPoint = {
  // Keys and indexes from the arguments object down to the string.
  readonly pointer: readonly (string | number)[];
  readonly kind: ArgumentKind;
  // "path", "items[0].url": how a report names the place.
  readonly label: string;
};

// One way to break the schema, and the arguments that do it.
export type Violation = {
  readonly label: string;
  readonly arguments: Record<string, unknown>;
};

const MAX_DEPTH = 4;
const MAX_POINTS = 16;

const PATH_NAME =
  /(^|[^a-z])(path|paths|file|files|filename|filepath|dir|dirs|directory|directories|folder|cwd|root|src|source|dst|dest|destination|target|location|output|input)($|[^a-z])/i;
const DIR_NAME =
  /(^|[^a-z])(dir|dirs|directory|directories|folder|cwd|root)($|[^a-z])/i;
const FRESH_NAME =
  /(^|[^a-z])(dst|dest|destination|target|output|to|new)($|[^a-z])/i;
const URL_NAME =
  /(^|[^a-z])(url|urls|uri|uris|link|href|endpoint|website|webpage)($|[^a-z])/i;
const COMMAND_NAME =
  /(^|[^a-z])(command|commands|cmd|script|shell|code|exec|expression|program)($|[^a-z])/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asSchema(value: unknown): SchemaNode {
  return isRecord(value) ? value : {};
}

// What an argument is for, from its name, its format, and its description.
// A wrong guess costs nothing here: every string gets the path and shell
// probes whatever its kind, and a finding needs evidence, not a guess.
export function kindOf(name: string, schema: SchemaNode): ArgumentKind {
  const spaced = name.replace(/([a-z])([A-Z])/g, "$1_$2");
  if (schema.format === "uri" || schema.format === "url") return "url";
  if (URL_NAME.test(spaced)) return "url";
  if (COMMAND_NAME.test(spaced)) return "command";
  if (PATH_NAME.test(spaced)) return "path";
  const description =
    typeof schema.description === "string" ? schema.description : "";
  if (
    /\b(file|directory|folder) ?(path|name)\b|\bpath to\b/i.test(description)
  ) {
    return "path";
  }
  if (/\burl\b/i.test(description)) return "url";
  return "text";
}

function typeOf(schema: SchemaNode): string | undefined {
  const declared = schema.type;
  if (typeof declared === "string") return declared;
  if (Array.isArray(declared)) {
    return declared.find(
      (item): item is string => typeof item === "string" && item !== "null",
    );
  }
  if (isRecord(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return undefined;
}

// A schema that offers alternatives is read as its first one.
function resolved(schema: SchemaNode): SchemaNode {
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) {
      const first = options.find(
        (option) => isRecord(option) && option.type !== "null",
      );
      if (isRecord(first)) return { ...schema, ...first };
    }
  }
  return schema;
}

// A value a correct server has no reason to turn down.
export function baseValue(
  name: string,
  given: SchemaNode,
  values: BaseValues,
  depth = 0,
): unknown {
  const schema = resolved(given);
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  const type = typeOf(schema);
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") {
    const low = typeof schema.minimum === "number" ? schema.minimum : 1;
    const high = typeof schema.maximum === "number" ? schema.maximum : low + 1;
    return Math.min(Math.max(1, low), high);
  }
  if (type === "array") {
    if (depth >= MAX_DEPTH || !isRecord(schema.items)) return [];
    return [baseValue(name, schema.items, values, depth + 1)];
  }
  if (type === "object") {
    return baseArguments(schema, values, depth + 1);
  }
  if (type === "null") return null;
  const kind = kindOf(name, schema);
  let text = "gauntlet";
  if (kind === "path") {
    const spaced = name.replace(/([a-z])([A-Z])/g, "$1_$2");
    if (FRESH_NAME.test(spaced)) text = values.fresh;
    else if (DIR_NAME.test(spaced)) text = values.dir;
    else text = values.path;
  } else if (kind === "url") text = values.url;
  else if (kind === "command") text = "echo gauntlet-ok";
  else if (schema.format === "date-time") text = "2026-01-01T00:00:00Z";
  else if (schema.format === "date") text = "2026-01-01";
  else if (schema.format === "email") text = "gauntlet@example.com";
  const least = typeof schema.minLength === "number" ? schema.minLength : 0;
  return kind === "text" && text.length < least
    ? text.padEnd(least, "g")
    : text;
}

// The arguments of a plain call: every required property, nothing else.
export function baseArguments(
  given: SchemaNode,
  values: BaseValues,
  depth = 0,
): Record<string, unknown> {
  const schema = resolved(given);
  const properties = asSchema(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  const result: Record<string, unknown> = {};
  if (depth > MAX_DEPTH) return result;
  for (const name of required) {
    if (typeof name !== "string") continue;
    set(
      result,
      name,
      baseValue(name, asSchema(properties[name]), values, depth),
    );
  }
  return result;
}

// Optional string properties, each with the value it would have. A scan adds
// them one at a time, so an optional `cwd` or `output` is probed too.
export function optionalStrings(
  given: SchemaNode,
  values: BaseValues,
): { name: string; value: unknown }[] {
  const schema = resolved(given);
  const properties = asSchema(schema.properties);
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const found: { name: string; value: unknown }[] = [];
  for (const [name, property] of Object.entries(properties)) {
    if (required.has(name)) continue;
    const value = baseValue(name, asSchema(property), values, 1);
    if (
      stringPoints({ [name]: value }, { properties: { [name]: property } })
        .length > 0
    ) {
      found.push({ name, value });
    }
  }
  return found;
}

// Every string in the arguments, with the kind its schema gives it.
export function stringPoints(
  args: Record<string, unknown>,
  given: SchemaNode,
): StringPoint[] {
  const points: StringPoint[] = [];
  const walk = (
    value: unknown,
    schema: SchemaNode,
    name: string,
    pointer: (string | number)[],
    label: string,
  ): void => {
    if (points.length >= MAX_POINTS || pointer.length > MAX_DEPTH * 2) return;
    const node = resolved(schema);
    if (typeof value === "string") {
      // A string the schema pins to a few values is not free text.
      if (Array.isArray(node.enum) || "const" in node) return;
      points.push({ pointer, kind: kindOf(name, node), label });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(
          item,
          asSchema(node.items),
          name,
          [...pointer, index],
          `${label}[${index}]`,
        );
      });
      return;
    }
    if (isRecord(value)) {
      const properties = asSchema(node.properties);
      for (const [key, item] of Object.entries(value)) {
        walk(
          item,
          asSchema(properties[key]),
          key,
          [...pointer, key],
          label.length > 0 ? `${label}.${key}` : key,
        );
      }
    }
  };
  walk(args, given, "", [], "");
  return points;
}

// Calls the schema forbids: a value of the wrong type, and a required
// property left out. Top level only. A property the schema does not list is
// not tried: most servers drop one without harm, and a finding for every
// tool would bury the ones that matter.
export function violations(
  given: SchemaNode,
  base: Record<string, unknown>,
): Violation[] {
  const schema = resolved(given);
  const properties = asSchema(schema.properties);
  const found: Violation[] = [];
  for (const name of Object.keys(base)) {
    const property = resolved(asSchema(properties[name]));
    const type = typeOf(property);
    const wrong = wrongValue(type);
    if (wrong !== undefined && !Array.isArray(property.type)) {
      found.push({
        label: `${name} as ${describe(wrong)}, where the schema says ${type}`,
        arguments: withValue(base, name, wrong),
      });
    }
    const without = clone(base);
    delete without[name];
    found.push({
      label: `no ${name}, which the schema requires`,
      arguments: without,
    });
  }
  return found;
}

function wrongValue(type: string | undefined): unknown {
  if (type === "string") return 7;
  if (type === "integer" || type === "number") return "seven";
  if (type === "boolean") return "yes";
  if (type === "array") return "gauntlet";
  if (type === "object") return "gauntlet";
  return undefined;
}

function describe(value: unknown): string {
  return typeof value === "string" ? "a string" : "a number";
}

// A copy of the arguments with one string replaced.
export function withString(
  args: Record<string, unknown>,
  pointer: readonly (string | number)[],
  value: unknown,
): Record<string, unknown> {
  const copy = clone(args);
  let node: unknown = copy;
  for (const [index, key] of pointer.entries()) {
    const last = index === pointer.length - 1;
    if (Array.isArray(node) && typeof key === "number") {
      if (last) node[key] = value;
      else node = node[key];
    } else if (isRecord(node) && typeof key === "string") {
      if (last) set(node, key, value);
      else node = node[key];
    } else {
      break;
    }
  }
  return copy;
}

export function withValue(
  args: Record<string, unknown>,
  name: string,
  value: unknown,
): Record<string, unknown> {
  const copy = clone(args);
  set(copy, name, value);
  return copy;
}

function clone(args: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(args);
}

// A defined property, so a name from a schema cannot be the prototype.
function set(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
