// Reads the input schema a tool declares, as far as a scan needs it: what a
// plain call looks like, where the strings in it are, and what the schema
// says must not be accepted. This is not a JSON Schema validator. It reads
// the keywords servers actually use and leaves the rest alone.

export type ArgumentKind = "path" | "url" | "command" | "text";

export type SchemaNode = Readonly<Record<string, unknown>>;

// The values a plain call is built from. Every one is unique to the scan,
// so a call that lands somewhere the scan did not expect names nothing that
// was already there.
export type BaseValues = {
  // A file that exists in the server's directory.
  readonly path: string;
  // A directory that exists there.
  readonly dir: string;
  // A name nothing has yet, for an argument that says where to put a result.
  readonly fresh: string;
  // An address that answers.
  readonly url: string;
  // A word for an argument that is plain text.
  readonly text: string;
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
export const MAX_POINTS = 16;
// An id nothing has. A tool that acts on a record, a process, or a port by
// number is given this one and not 1.
const UNUSED_NUMBER = 987_654_321;

const PATH_NAME =
  /(^|[^a-z])(path|paths|file|files|filename|filepath|dir|dirs|directory|directories|folder|cwd|root|src|source|dst|dest|destination|target|location|output|input)($|[^a-z])/i;
const DIR_NAME =
  /(^|[^a-z])(dir|dirs|directory|directories|folder|cwd|root)($|[^a-z])/i;
const FRESH_NAME =
  /(^|[^a-z])(dst|dest|destination|target|output|to|new)($|[^a-z])/i;
// What takes the place of something: newText, new_string, replacement.
const NEW_TEXT_NAME = /(^|[^a-z])(new|replacement|replace|with)($|[^a-z])/i;
const URL_NAME =
  /(^|[^a-z])(url|urls|uri|uris|link|href|endpoint|website|webpage)($|[^a-z])/i;
const COMMAND_NAME = /(^|[^a-z])(command|commands|cmd|shell|script)($|[^a-z])/i;
const ID_NAME =
  /(^|[^a-z])(id|ids|pid|uid|gid|port|index|offset|number)($|[^a-z])/i;
// A switch that makes a call do less. It is turned on.
const SAFE_SWITCH =
  /(^|[^a-z])(dry|dryrun|preview|simulate|noop|readonly|safe|check)($|[^a-z])/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asSchema(value: unknown): SchemaNode {
  return isRecord(value) ? value : {};
}

function words(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1_$2");
}

// What an argument is for, from its name, its format, and its description.
// The kind picks the value of a plain call and which addresses a URL gets.
// It does not decide whether an argument gets shell payloads: every string
// does, unless the tool as a whole runs commands.
export function kindOf(name: string, schema: SchemaNode): ArgumentKind {
  const spaced = words(name);
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

// Reads one schema against the document it is part of.
export type SchemaReader = {
  // Whether the tool published a schema with any argument in it.
  readonly described: boolean;
  // The arguments of a plain call: every required property, nothing else.
  plain(values: BaseValues): Record<string, unknown>;
  // Optional properties that hold a string, each with the value it would
  // have. A scan adds them one at a time.
  optional(values: BaseValues): { name: string; value: unknown }[];
  // Every free string in the arguments, and how many more there were than
  // a scan looks at.
  points(args: Record<string, unknown>): {
    points: StringPoint[];
    skipped: number;
  };
  // Calls the schema forbids. withMissing adds the calls that leave a
  // required argument out.
  violations(base: Record<string, unknown>, withMissing: boolean): Violation[];
};

export function readSchema(document: unknown): SchemaReader {
  const root = asSchema(document);

  // A schema that points elsewhere in the document is read there. A schema
  // that offers alternatives is read as its first one.
  const resolved = (given: SchemaNode, hops = 0): SchemaNode => {
    if (hops > 8) return given;
    const ref = given.$ref;
    if (typeof ref === "string" && ref.startsWith("#/")) {
      let node: unknown = root;
      for (const part of ref.slice(2).split("/")) {
        const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
        node = isRecord(node) ? node[key] : undefined;
      }
      if (isRecord(node)) {
        return resolved({ ...given, $ref: undefined, ...node }, hops + 1);
      }
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const options = given[key];
      if (Array.isArray(options) && options.length > 0) {
        const first = options.find(
          (option) => isRecord(option) && option.type !== "null",
        );
        if (isRecord(first)) {
          return resolved({ ...given, [key]: undefined, ...first }, hops + 1);
        }
      }
    }
    return given;
  };

  // More than one type is allowed here, so no one wrong type can be named.
  const open = (given: SchemaNode): boolean =>
    Array.isArray(given.type) ||
    Array.isArray(given.anyOf) ||
    Array.isArray(given.oneOf) ||
    Array.isArray(given.allOf);

  const value = (
    name: string,
    given: SchemaNode,
    values: BaseValues,
    depth: number,
  ): unknown => {
    const schema = resolved(given);
    if (schema.const !== undefined) return schema.const;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return schema.enum[0];
    }
    const type = typeOf(schema);
    const spaced = words(name);
    if (type === "boolean") return SAFE_SWITCH.test(spaced);
    if (type === "integer" || type === "number") {
      const low = typeof schema.minimum === "number" ? schema.minimum : 1;
      const high =
        typeof schema.maximum === "number"
          ? schema.maximum
          : Number.MAX_SAFE_INTEGER;
      const wanted = ID_NAME.test(spaced) ? UNUSED_NUMBER : 1;
      return Math.min(Math.max(wanted, low), high);
    }
    if (type === "array") {
      if (depth >= MAX_DEPTH || !isRecord(schema.items)) return [];
      return [value(name, schema.items, values, depth + 1)];
    }
    if (type === "object") return object(schema, values, depth + 1);
    if (type === "null") return null;
    const kind = kindOf(name, schema);
    let text = values.text;
    if (kind === "path") {
      if (FRESH_NAME.test(spaced)) text = values.fresh;
      else if (DIR_NAME.test(spaced)) text = values.dir;
      else text = values.path;
    } else if (kind === "url") text = values.url;
    else if (kind === "command") text = `echo ${values.text}`;
    else if (schema.format === "date-time") text = "2026-01-01T00:00:00Z";
    else if (schema.format === "date") text = "2026-01-01";
    else if (schema.format === "email") text = `${values.text}@example.com`;
    // A tool that replaces one text with another is given two that differ,
    // so a plain call changes the file and is seen to.
    else if (NEW_TEXT_NAME.test(spaced)) text = `${values.text}-new`;
    const least = typeof schema.minLength === "number" ? schema.minLength : 0;
    return kind === "text" && text.length < least
      ? text.padEnd(least, "g")
      : text;
  };

  const object = (
    given: SchemaNode,
    values: BaseValues,
    depth: number,
  ): Record<string, unknown> => {
    const schema = resolved(given);
    const properties = asSchema(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    const result: Record<string, unknown> = {};
    if (depth > MAX_DEPTH) return result;
    for (const name of required) {
      if (typeof name !== "string") continue;
      set(result, name, value(name, asSchema(properties[name]), values, depth));
    }
    return result;
  };

  const points = (
    args: Record<string, unknown>,
  ): { points: StringPoint[]; skipped: number } => {
    const found: StringPoint[] = [];
    let skipped = 0;
    const walk = (
      item: unknown,
      schema: SchemaNode,
      name: string,
      pointer: (string | number)[],
      label: string,
    ): void => {
      if (pointer.length > MAX_DEPTH * 2) return;
      const node = resolved(schema);
      if (typeof item === "string") {
        // A string the schema pins to a few values is not free text.
        if (Array.isArray(node.enum) || node.const !== undefined) return;
        if (found.length >= MAX_POINTS) {
          skipped += 1;
          return;
        }
        found.push({ pointer, kind: kindOf(name, node), label });
        return;
      }
      if (Array.isArray(item)) {
        item.forEach((entry, index) => {
          walk(
            entry,
            asSchema(node.items),
            name,
            [...pointer, index],
            `${label}[${index}]`,
          );
        });
        return;
      }
      if (isRecord(item)) {
        const properties = asSchema(node.properties);
        for (const [key, entry] of Object.entries(item)) {
          walk(
            entry,
            asSchema(properties[key]),
            key,
            [...pointer, key],
            label.length > 0 ? `${label}.${key}` : key,
          );
        }
      }
    };
    walk(args, root, "", [], "");
    return { points: found, skipped };
  };

  return {
    described: Object.keys(asSchema(resolved(root).properties)).length > 0,
    plain: (values) => object(root, values, 0),
    optional(values) {
      const schema = resolved(root);
      const properties = asSchema(schema.properties);
      const required = new Set(
        Array.isArray(schema.required) ? schema.required : [],
      );
      const found: { name: string; value: unknown }[] = [];
      for (const [name, property] of Object.entries(properties)) {
        if (required.has(name)) continue;
        // An optional object is filled in with its own strings, required or
        // not, so a path one level down is reached too.
        const node = resolved(asSchema(property));
        let filled = value(name, node, values, 1);
        if (typeOf(node) === "object" && isRecord(filled)) {
          let record: Record<string, unknown> = filled;
          for (const [inner, innerSchema] of Object.entries(
            asSchema(node.properties),
          )) {
            if (Object.hasOwn(record, inner)) continue;
            const innerNode = resolved(asSchema(innerSchema));
            const innerType = typeOf(innerNode);
            if (innerType === "string" || innerType === undefined) {
              record = withValue(
                record,
                inner,
                value(inner, innerNode, values, 2),
              );
            }
          }
          filled = record;
        }
        if (hasString(filled)) found.push({ name, value: filled });
      }
      return found;
    },
    points,
    violations(base, withMissing) {
      const schema = resolved(root);
      const properties = asSchema(schema.properties);
      const found: Violation[] = [];
      for (const name of Object.keys(base)) {
        const declared = asSchema(properties[name]);
        const property = resolved(declared);
        const type = typeOf(property);
        const wrong = wrongValue(type);
        if (wrong !== undefined && !open(declared) && !open(property)) {
          found.push({
            label: `${name} as ${describe(wrong)}, where the schema says ${type}`,
            arguments: withValue(base, name, wrong),
          });
        }
        if (!withMissing) continue;
        const without = clone(base);
        delete without[name];
        found.push({
          label: `no ${name}, which the schema requires`,
          arguments: without,
        });
      }
      return found;
    },
  };
}

function hasString(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.some(hasString);
  if (isRecord(value)) return Object.values(value).some(hasString);
  return false;
}

// A value no reading of the type accepts. "yes" and "1" are not used: a
// lenient validator reads them as true and as one. The number is one nothing
// is named after, in case a tool turns it into a name.
function wrongValue(type: string | undefined): unknown {
  if (type === "string") return UNUSED_NUMBER;
  if (type === "integer" || type === "number") return "seven";
  if (type === "boolean") return "gauntlet";
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
