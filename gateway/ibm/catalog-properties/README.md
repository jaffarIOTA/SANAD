# Catalog properties

Values that differ per environment, held here rather than as defaults in the
API definitions.

## Why there are no defaults in the definitions

A default is an environment's hostname committed to git, and the failure it
produces is the bad kind: publish to a production catalog without overriding
it, and production transacts against a sandbox while every test stays green.

An absent value fails at publish. A wrong value fails in production, quietly,
against real money.

## Applying them

```sh
apic properties:create --scope catalog \
  --server "$APIC_SERVER" --org "$APIC_ORG" --catalog <catalog> \
  gateway/ibm/catalog-properties/<catalog>.yaml
```

`properties:create` augments the catalog's configuration with the name/value
pairs in the file. To change one afterwards:

```sh
apic properties:update --scope catalog \
  --server "$APIC_SERVER" --org "$APIC_ORG" --catalog <catalog> \
  tuum-base-url ./new-value.yaml
```

Read back what is actually set — worth doing after any change, because a
property that silently did not apply looks identical to one that did:

```sh
apic properties:list --scope catalog \
  --server "$APIC_SERVER" --org "$APIC_ORG" --catalog <catalog>
```

## One file per catalog, and catalogs are environments

`sandbox.yaml` here, `uat.yaml` and `production.yaml` when those exist.

**A catalog is an environment, not a grouping of related APIs.** That is what
a Product is for. See the note in `../README.md`.
