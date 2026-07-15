# Data diagrams

Use an ER diagram for persistent records and their relationships.

Show entities, cardinality, important keys, and ownership. Use the storage
schema as the source of truth. Do not add service methods or transient events;
use an architecture or sequence diagram for those.

## Example

```mermaid
erDiagram
  SESSION ||--o{ MESSAGE : contains
  SESSION { string id PK }
  MESSAGE { string id PK
            string session_id FK }
```
