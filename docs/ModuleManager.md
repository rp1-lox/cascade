# ModuleManager 4.2.3 — Complete Syntax Reference

Verified against sarbian/ModuleManager wiki, the KSP-ModularManagement fork, and this install's
cache/behavior. This is the write-path bible for the Engine Editor.

## 1. Data model

KSP configs are ConfigNode trees: top-level typed nodes (`PART`, `B9_TANK_TYPE`, `EFFECTTEMPLATE`,
`RESOURCE_DEFINITION`, ...) holding `key = value` pairs and nested nodes. `//` comments. MM patches
are top-level nodes whose type carries an operator prefix. Everything without a prefix is base data.

## 2. Node-level operators

| Op | Meaning |
|---|---|
| *(none)* | Insert (base data, loaded before patching). Optional `,index` places at position: `MODULE,0 { }`. |
| `@` | Edit in place. First match only unless `,index` / `,*`. |
| `+` or `$` | **Copy.** Full snapshot of the matched node *as it exists in the current pass*, appended to the database; the patch body then applies as edits to the copy. **Top-level `+PART` copies MUST `@name = newName`** or the duplicate name collides. The copy is a first-class part from that pass onward: later passes' wildcard selectors match its NEW name (it escapes patches matching the old name, inherits any matching the new one). This is the canonical "derive a new engine" mechanism (AR-1E_patch.cfg, SSALAD F1Ethalox). Inside a patch body, `+NODE {}` copies a child node similarly. |
| `-` or `!` | Delete. **Braces required**: `!EFFECTS {}`. Bare `!EFFECTS` (no braces) is parsed as a value op with no `=` and is SILENTLY IGNORED — a classic footgun (SSALAD's Ethalox ended up with two EFFECTS blocks this way). No index ⇒ deletes ALL matches. |
| `%` | Edit-or-create (upsert). |
| `&` | Create only if absent. |
| `|` | Rename node type (not usable on top-level nodes). |
| `#` | Copy a node from another path into the current location: `#@PART[donor]/MODULE[ModuleEnginesFX] {}` (body then edits the pasted copy). |

### Selector grammar
`<op><NodeType>[<NameFilter>](:HAS[...])?(,index)?`
- NameFilter matches the node's `name =` value. Wildcards `*` (any run) and `?` (single char; also
  stands in for spaces/illegal chars). `|` inside brackets = OR: `@PART[a|b|c*]`.
- Index: `,0` first, `,-1` last, `,*` all matches. Indexes cannot combine with `:HAS` on the same
  selector.
- Bare `@NODETYPE` (no brackets) matches by type; `NODETYPE[*]` requires the node to HAVE a name.

### :HAS[...] filters
Conditions separated by `,` or `&` (both AND); each may nest its own `:HAS`:
- `@NODE[name]` has child node · `!NODE[name]` / `-NODE[name]` lacks child node
- `#key[value]` key exists and matches (wildcards; numeric `#mass[<1]`, `[>2]`)
- `~key[value]` key absent or value doesn't match
- Nesting: `:HAS[@MODULE[ModuleEngines*]:HAS[@PROPELLANT[Oxidizer]]]`
- HAS state is evaluated at the moment the patch runs (mid-patch state, not base state).

## 3. Value-level operators (inside a patch body)

| Syntax | Meaning |
|---|---|
| `key = v` | Insert/append. `key,index = v` inserts at position. |
| `@key = v` | Edit first match. `@key,i = v` i-th (`,-1` last, `,*` all). |
| `@key += n` `-=` `*=` `/=` | Arithmetic. `!=` is exponentiation (since `^` is taken by regex). |
| `@key ^= :pat:repl:` | Regex substitution (any delimiter char after `^= `). `:$: suffix:` appends, `:^:prefix :` prepends, `$0` = whole match. Used by SSALAD: `@title ^= :$:-E Ethalox engine`. |
| `!key = _` / `-key = _` | Delete value. RHS required but ignored. All matches unless indexed. |
| `%key = v` | Upsert. `&key = v` create-if-absent. |
| `@key,i[j]` / `@key,i[j,sep]` | Edit element j of a multi-element value split on sep (default `,`). `[*]` = all elements. |

### Variable references
`#$<path>$` in any RHS resolves at patch time:
- `#$../mass$` relative up · `#$/key$` root of current top-level node
- `#$@PART[donor]/MODULE[ModuleEngines]/atmosphereCurve/key,1[1, ]$` absolute cross-node, with
  node indexes and value-element indexing (element 1 of key #1, space-separated)
- Combines with arithmetic: `@cost *= #$../scaleFactor$` (CryoTanks' massOffset pattern).

## 4. :NEEDS[]
Attachable to top-level nodes, patches, sub-nodes, and individual VALUES
(`description:NEEDS[RealFuels] = ...`). Ops: `&`/`,` AND, `|` OR, `!` NOT. Precedence quirk: AND
binds LOOSER — `A|B&!C|D` ⇒ `(A|B) & (!C|D)`. A name "exists" if it is: a loaded DLL name, a
GameData top-level directory (whitespace stripped), or ANY `:FOR[name]` seen anywhere (⇒ `:FOR`
*declares* mods — RealPlume-Stock declares `zRealPlume` this way). Case-insensitive. Directory
tests allowed: `:NEEDS[Squad/Parts]`. Unsatisfied ⇒ node/value removed before patching.

## 5. Pass ordering
1. Base nodes load; NEEDS stripping.
2. Mod-name list built (DLLs + GameData dirs + all `:FOR` names).
3. `:BEFORE`/`:AFTER` referencing unknown names ⇒ patch discarded (`:FOR` of unknown name creates it).
4. Passes: `:FIRST` → **unsuffixed ("legacy")** → for each modname in Unicode-sorted order:
   `:BEFORE[mod]` → `:FOR[mod]` → `:AFTER[mod]` → then `:LAST[mod]` (sorted) → `:FINAL`.
5. Within every pass: alphabetical by full file path. One ordering directive per patch.

Ordering-as-API in this install: `zzz_CryoTanks` sorts after `Bluedog_DB_1` so BDB converts its
tanks first and CryoTanks' wildcards skip them; our patches use folder `zzzz_EngineEditor` +
`:FINAL` to sort after every other `:FINAL` patch (verified against the selector index).

## 6. ModuleManager.ConfigCache (read-path ground truth)
```
patchedNodeCount = 87480
UrlConfig
{
	parentUrl = CryoEngines/Parts/.../file.cfg    // source file of the ORIGINAL node
	PART { ...fully patched final state... }      // exactly one child per UrlConfig
}
```
- One UrlConfig per surviving top-level node, database order; N nodes in a file ⇒ N UrlConfigs with
  the same parentUrl. Root-level files: `/name.cfg`. Deleted nodes absent; patch nodes consumed.
- **Copies keep the ORIGINAL's parentUrl** (NFLV_AR1E shows `parentUrl = .../nflv-engine-ar1-1.cfg`)
  — a copied part's "source file" does not contain its name; resolve through the copy patch.
- Waterfall `TEMPLATE` refs are NOT expanded (runtime); `EFFECTTEMPLATE`s are separate UrlConfigs.
- Companions: `ModuleManager.ConfigSHA` (per-file SHA-256s — cache invalidation key, our staleness
  stamp), `ModuleManager.Physics`, `ModuleManager.TechTree`.

## 7. Lint rules for generated/user patches (validator)
1. `!NODE` without `{}` — silently ignored deletion (SSALAD bug class). ERROR.
2. Top-level `+PART` without `@name =` — name collision. ERROR.
3. `+PART` new name matched by existing wildcard selectors in later passes — unintended patching.
   WARN with the list of matching patch files.
4. `:FINAL` patch that alphabetically follows `zzzz_EngineEditor` — our edit not last. ERROR.
5. Waterfall `engineID` ≠ any engine module's `engineID` — benign fallback to first engine. WARN.
6. `templateName` not resolving to any EFFECTTEMPLATE in cache. ERROR.
7. B9PS `IDENTIFIER` matching zero or >1 modules on the part (B9PS hard-errors in game). ERROR.
8. Deleting/editing a path whose final writer is a later patch (provenance) — dead edit. WARN with
   winner file + pass.
