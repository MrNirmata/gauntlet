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
  // More files that exist there, for a second and a third path argument.
  // Each argument gets a value no other has, so what a call did can be put
  // down to the argument that named it.
  readonly others?: readonly string[];
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

const MAX_DEPTH = 6;
export const MAX_POINTS = 16;
// How many values one call is built from. A schema that asks for more is
// filled in as far as this and no further.
const MAX_VALUES = 2000;
// The longest string made to satisfy a minLength.
const MAX_PADDING = 4096;
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
  /(^|[^a-z])(id|ids|pid|uid|gid|port|number|num|no|seq|row|line|issue|key|ticket|record|item|entry)($|[^a-z])/i;
// Where to begin. Nothing is the natural place.
const START_NAME = /(^|[^a-z])(offset|index|start|skip|from|page)($|[^a-z])/i;
// How much to return or keep. A plain call asks for plenty: one line of a
// file shows nothing, and a log trimmed to one entry has lost the rest.
const LIMIT_NAME =
  /(^|[^a-z])(limit|length|size|max|maximum|lines|chars|bytes|entries|results|top|tail|head)($|[^a-z])/i;
// A switch that makes a call do less. It is turned on, unless its name
// turns it round: no_dry_run, skip_safety_check, disable_preview.
const SAFE_SWITCH =
  /(^|[^a-z])(dry|dryrun|preview|simulate|noop|readonly|read[^a-z]?only|safe|check)($|[^a-z])/i;
const NEGATED =
  /(^|[^a-z])(no|not|non|skip|disable|disabled|without|dont|never|bypass|ignore|suppress|omit)($|[^a-z])/i;
// A switch that makes a call do more. It is left off whatever its default.
const RISKY_SWITCH =
  /(^|[^a-z])(force|forced|overwrite|replace|recursive|delete|remove|purge|prune|clean|clear|wipe|reset|all|confirm|confirmed|yes|hard|permanent)($|[^a-z])/i;
// An argument that asks whether the caller means it.
const CONFIRMS =
  /(^|[^a-z])(confirm|confirmed|confirmation|force|forced|yes|sure|acknowledge)($|[^a-z])/i;
// A switch that holds on to what is there. It is turned on.
const KEEP_SWITCH =
  /(^|[^a-z])(keep|preserve|backup|existing|append)($|[^a-z])/i;
// A value of an option that does less, and one that does more.
const SAFE_OPTION =
  /(^|[^a-z])(dry|preview|simulate|safe|soft|append|add|merge|keep|skip|fail|error|abort|none|no|false|off|read|readonly|r|ro|staging|test|dev|sandbox)($|[^a-z])/i;
const RISKY_OPTION =
  /(^|[^a-z])(replace|overwrite|write|hard|force|production|prod|yes|true|on|w|rw|all)($|[^a-z])/i;

// What a name says a tool or an option does. The name is all there is to go
// on: most servers mark nothing. A name is read word by word.
const wordSet = (list: string): ReadonlySet<string> => new Set(list.split(" "));
// Removing, sending, spending, or putting back.
const CHANGES = wordSet(
  "delete del remove rm rmrf rmdir unlink drop destroy purge prune wipe erase expunge nuke shred clear clean cleanup empty truncate trim flush expire evict trash discard forget unset pop dequeue kill killall terminate stop halt shutdown reboot restart send post publish deploy release pay charge refund transfer withdraw purchase buy order book email mail sms tweet notify invite merge push commit stash restore reset revert rollback rotate archive format uninstall revoke ban block cancel close logout overwrite replace reinit migrate migration apply",
);
// The ones that are never the name of a thing. list_orders lists orders.
// list_purge does not only list.
const REMOVES = wordSet(
  "delete del remove rm rmrf rmdir unlink drop destroy purge prune wipe erase expunge nuke shred clear truncate trim flush kill killall uninstall overwrite replace",
);
// The same, run together with what they act on: deletefile, dropdb, wipedisk.
const RUN_TOGETHER =
  /^(delete|remove|rmdir|unlink|drop|destroy|purge|wipe|erase|truncate|kill|uninstall)/;
// Changing something without removing it.
const WRITES = wordSet(
  "add append create set update insert write put save store install execute exec run increment decrement upload import edit modify change rename move copy sync start enable disable toggle mark assign grant lock unlock register login connect make build",
);
const JOINS = wordSet("and then or");
// A name that starts by saying it only looks: get_user, list_files.
const LOOKS = wordSet(
  "get list read search find grep fetch show view describe count query lookup check is has stat info status peek inspect ls cat head tail diff compare validate verify explain preview",
);

// The words of a name, lower case. A word with a letter outside a to z is
// kept whole, and is not one this reads.
function tokens(name: string): string[] {
  return words(name)
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

// What a tool's name says it does: only looks, removes or sends or spends,
// or nothing either way. "Only looks" is the one answer that lets a scan
// call a tool unasked, so it is the hardest to get: the first word says it
// looks, and no later word says, or could say, that it does more.
export function nature(name: string): "reads" | "removes" | "unknown" {
  const [first = "", ...rest] = tokens(name);
  const all = [first, ...rest];
  const removes = (word: string): boolean =>
    REMOVES.has(word) || RUN_TOGETHER.test(word);
  if (!LOOKS.has(first)) {
    return all.some((word) => CHANGES.has(word) || RUN_TOGETHER.test(word))
      ? "removes"
      : "unknown";
  }
  if (rest.some((word) => JOINS.has(word) || removes(word))) return "removes";
  // check_in and check_out are not checks.
  if (first === "check" && (rest[0] === "in" || rest[0] === "out")) {
    return "unknown";
  }
  return rest.some(
    (word) => CHANGES.has(word) || WRITES.has(word) || !/^[a-z]+$/.test(word),
  )
    ? "unknown"
    : "reads";
}

// Whether a name says the thing removes, sends, or spends.
export function soundsDestructive(name: string): boolean {
  return nature(name) === "removes";
}

// Whether a name is one a switch has: an argument that turns something on,
// whatever type the schema gives it.
export function soundsLikeSwitch(name: string): boolean {
  const spaced = words(name);
  return (
    SAFE_SWITCH.test(spaced) ||
    RISKY_SWITCH.test(spaced) ||
    KEEP_SWITCH.test(spaced)
  );
}

// What a switch is set to: on when that does less or keeps what is there.
function switchValue(name: string, fallback: boolean): boolean {
  const spaced = words(name);
  const negated = NEGATED.test(spaced);
  if (RISKY_SWITCH.test(spaced)) return negated;
  if (SAFE_SWITCH.test(spaced) || KEEP_SWITCH.test(spaced)) return !negated;
  return fallback;
}

// Of the values an option allows, the one that does least.
function leastOf(options: readonly unknown[], name: string): unknown {
  // true or false under another type: a switch with two values.
  if (options.every((option) => typeof option === "boolean")) {
    const wanted = switchValue(name, false);
    return options.includes(wanted) ? wanted : options[0];
  }
  const named = options.filter(
    (option): option is string => typeof option === "string",
  );
  const risky = (option: string): boolean => RISKY_OPTION.test(words(option));
  const safe = (option: string): boolean => {
    const spaced = words(option);
    return LOOKS.has(tokens(option)[0] ?? "") || SAFE_OPTION.test(spaced);
  };
  return (
    named.find((option) => safe(option) && !risky(option)) ??
    named.find((option) => !risky(option) && !soundsDestructive(option)) ??
    named.find((option) => !soundsDestructive(option)) ??
    options[0]
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asSchema(value: unknown): SchemaNode {
  return isRecord(value) ? value : {};
}

// A name with its words apart: readFile and XMLDelete as read_File and
// XML_Delete.
export function words(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2");
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
  const description =
    typeof schema.description === "string" ? schema.description : "";
  // Said outright, which counts for more than a name like "input".
  if (
    /\b(shell )?command\b[^.]{0,30}\b(to )?(run|execute)\b|\b(run|execute)s?\b[^.]{0,30}\bcommand\b/i.test(
      description,
    )
  ) {
    return "command";
  }
  if (PATH_NAME.test(spaced)) return "path";
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
  // Whether the last call built is missing something the schema requires,
  // because the schema is deeper or wider than a scan fills in.
  truncated(): boolean;
  // Whether the tool requires an argument that asks if the caller means it:
  // confirm, force, yes.
  confirms(): boolean;
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
  // Calls the schema forbids. canDrop says which arguments may also be left
  // out, to see whether the server notices one is missing.
  violations(
    base: Record<string, unknown>,
    canDrop: (name: string) => boolean,
  ): Violation[];
};

export function readSchema(document: unknown): SchemaReader {
  const root = asSchema(document);

  // The schema a $ref names, when it names one in this document.
  const target = (given: SchemaNode): SchemaNode | undefined => {
    const ref = given.$ref;
    if (ref === "#") return root;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
    let node: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      node = isRecord(node) ? node[key] : undefined;
    }
    return isRecord(node) ? node : undefined;
  };

  // A schema that points elsewhere in the document is read there. A schema
  // that offers alternatives is read as its first one.
  const resolved = (given: SchemaNode, hops = 0): SchemaNode => {
    if (hops > 8) return given;
    const named = target(given);
    if (named !== undefined) {
      return resolved({ ...given, $ref: undefined, ...named }, hops + 1);
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

  // More than one type is allowed here, or somewhere a $ref leads, so no
  // one wrong type can be named.
  const open = (given: SchemaNode, hops = 0): boolean => {
    if (
      Array.isArray(given.type) ||
      Array.isArray(given.anyOf) ||
      Array.isArray(given.oneOf) ||
      Array.isArray(given.allOf)
    ) {
      return true;
    }
    const named = target(given);
    return named !== undefined && hops < 8 && open(named, hops + 1);
  };

  // What one call has been given so far. No two arguments get the same
  // string where another one can be made.
  let spent = 0;
  // Whether the call being built is missing something its schema requires,
  // because the schema is deeper or wider than a scan fills in.
  let cut = false;
  let taken = new Set<string>();
  const begin = (): void => {
    spent = 0;
    cut = false;
    taken = new Set();
  };
  const unique = (text: string, next: (round: number) => string): string => {
    let candidate = text;
    for (let round = 2; taken.has(candidate) && round < 40; round += 1) {
      candidate = next(round);
    }
    taken.add(candidate);
    return candidate;
  };

  const value = (
    name: string,
    given: SchemaNode,
    values: BaseValues,
    depth: number,
  ): unknown => {
    const schema = resolved(given);
    if (schema.const !== undefined) return schema.const;
    spent += 1;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return leastOf(schema.enum, name);
    }
    const type = typeOf(schema);
    const spaced = words(name);
    if (type === "boolean") {
      return switchValue(
        name,
        typeof schema.default === "boolean" ? schema.default : false,
      );
    }
    if (type === "integer" || type === "number") {
      // A switch written as a number is off, and a place to begin is the
      // beginning.
      const zero =
        (RISKY_SWITCH.test(spaced) && !NEGATED.test(spaced)) ||
        START_NAME.test(spaced);
      const low =
        typeof schema.minimum === "number" ? schema.minimum : zero ? 0 : 1;
      const high =
        typeof schema.maximum === "number"
          ? schema.maximum
          : Number.MAX_SAFE_INTEGER;
      const wanted = zero
        ? 0
        : ID_NAME.test(spaced)
          ? UNUSED_NUMBER
          : LIMIT_NAME.test(spaced)
            ? 1000
            : 1;
      return Math.min(Math.max(wanted, low), high);
    }
    if (type === "array") {
      if (depth >= MAX_DEPTH || spent > MAX_VALUES) {
        cut = true;
        return [];
      }
      // Never an empty list: that is what a tool reads as "all of them".
      // Where the schema does not say what goes in it, a word of the scan's.
      return [
        value(
          name,
          isRecord(schema.items) ? schema.items : { type: "string" },
          values,
          depth + 1,
        ),
      ];
    }
    if (type === "object") {
      const filled = object(schema, values, depth + 1);
      // A map with no fixed keys gets one, named by the scan.
      if (
        Object.keys(filled).length === 0 &&
        Object.keys(asSchema(schema.properties)).length === 0
      ) {
        const word = unique(values.text, (round) => `${values.text}-${round}`);
        set(filled, word, word);
      }
      return filled;
    }
    if (type === "null") return null;
    const kind = kindOf(name, schema);
    if (kind === "url") return values.url;
    if (kind === "command") return `echo ${values.text}`;
    if (kind === "path") {
      if (FRESH_NAME.test(spaced)) {
        const dot = values.fresh.lastIndexOf(".");
        const cut = dot > 0 ? dot : values.fresh.length;
        return unique(
          values.fresh,
          (round) =>
            `${values.fresh.slice(0, cut)}-${round}${values.fresh.slice(cut)}`,
        );
      }
      if (DIR_NAME.test(spaced)) return values.dir;
      const others = values.others ?? [];
      return unique(values.path, (round) => others[round - 2] ?? values.path);
    }
    if (schema.format === "date-time" || schema.format === "date") {
      // Not a day anything of the user's is filed under. "Before" and
      // "until" get the far past and "since" and "after" the far future, so
      // a range of dates takes in nothing.
      const day =
        /(^|[^a-z])(since|after|from|start|begin|newer)($|[^a-z])/i.test(spaced)
          ? "9999-12-31"
          : "1970-01-02";
      return schema.format === "date" ? day : `${day}T00:00:00Z`;
    }
    // A switch written as a string.
    if (soundsLikeSwitch(name)) return String(switchValue(name, false));
    if (schema.format === "email") return `${values.text}@example.com`;
    // A tool that replaces one text with another is given two that differ,
    // so a plain call changes the file and is seen to.
    const word = NEW_TEXT_NAME.test(spaced)
      ? `${values.text}-new`
      : values.text;
    const text = unique(word, (round) => `${word}-${round}`);
    const least =
      typeof schema.minLength === "number"
        ? Math.min(schema.minLength, MAX_PADDING)
        : 0;
    return text.length < least ? text.padEnd(least, "g") : text;
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
    if (depth > MAX_DEPTH) {
      if (required.length > 0) cut = true;
      return result;
    }
    for (const name of required) {
      if (typeof name !== "string") continue;
      if (spent > MAX_VALUES) {
        cut = true;
        break;
      }
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
        // A string the schema pins to a few values is not free text, and a
        // switch written as a string is not a place for a payload: any text
        // in it may read as on.
        if (Array.isArray(node.enum) || node.const !== undefined) return;
        if (soundsLikeSwitch(name) && kindOf(name, node) === "text") return;
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
    truncated: () => cut,
    confirms() {
      // Followed through a $ref, and one object down.
      const walk = (given: SchemaNode, depth: number): boolean => {
        const schema = resolved(given);
        const properties = asSchema(schema.properties);
        const required = Array.isArray(schema.required) ? schema.required : [];
        return required.some((name) => {
          if (typeof name !== "string") return false;
          if (CONFIRMS.test(words(name))) return true;
          return depth < 3 && walk(asSchema(properties[name]), depth + 1);
        });
      };
      return walk(root, 0);
    },
    plain(values) {
      begin();
      return object(root, values, 0);
    },
    optional(values) {
      // After the required ones, so an optional argument gets a value none
      // of them has.
      begin();
      object(root, values, 0);
      const schema = resolved(root);
      const properties = asSchema(schema.properties);
      const required = new Set(
        Array.isArray(schema.required) ? schema.required : [],
      );
      const found: { name: string; value: unknown }[] = [];
      for (const [name, property] of Object.entries(properties)) {
        if (required.has(name)) continue;
        // An optional switch is not added, whatever type it is written as.
        // A path named backup_file is a path, and is added.
        if (
          CONFIRMS.test(words(name)) ||
          (soundsLikeSwitch(name) &&
            kindOf(name, asSchema(property)) === "text")
        ) {
          continue;
        }
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
    violations(base, canDrop) {
      const schema = resolved(root);
      const properties = asSchema(schema.properties);
      const found: Violation[] = [];
      for (const name of Object.keys(base)) {
        const declared = asSchema(properties[name]);
        const property = resolved(declared);
        const type = typeOf(property);
        // A switch or an option is left as the plain call set it. A wrong
        // value for one may read as on, and leaving it out gives the tool's
        // own default. That goes for a switch of any type.
        if (
          type === "boolean" ||
          Array.isArray(property.enum) ||
          property.const !== undefined ||
          soundsLikeSwitch(name)
        ) {
          continue;
        }
        const wrong = wrongValue(type);
        if (wrong !== undefined && !open(declared) && !open(property)) {
          found.push({
            label: `${name} as ${describe(wrong)}, where the schema says ${type}`,
            arguments: withValue(base, name, wrong),
          });
        }
        if (!canDrop(name)) continue;
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
  // A number where a list goes. Not a string: a tool that walks a list
  // would walk its letters, and act on a name one letter long. Nothing in
  // place of an object, which would leave every part of it out.
  if (type === "array") return UNUSED_NUMBER;
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
