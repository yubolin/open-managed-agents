---
name: software-architecture
description: Enforce Clean Architecture, SOLID principles, and enterprise design patterns. Use when designing new modules, reviewing architecture decisions, or refactoring existing code.
---

# Software Architecture Skill

Enforce industry-standard software architecture patterns to ensure maintainable, testable, and scalable code.

## When to Use

- Designing new modules or services
- Reviewing architecture decisions
- Refactoring existing code for better structure
- Setting up project directory structure
- Making technology or pattern choices

## Architecture Principles

### 1. Clean Architecture (Layered Dependencies)

Dependencies MUST flow inward. Outer layers depend on inner layers, never the reverse.

```
┌──────────────────────────────────┐
│          Presentation            │  ← FastAPI Routers, Pydantic Schemas
│  ┌──────────────────────────┐    │
│  │       Application        │    │  ← Use Cases, Service Layer
│  │  ┌──────────────────┐    │    │
│  │  │      Domain       │    │    │  ← Entities, Business Rules
│  │  │  ┌────────────┐   │    │    │
│  │  │  │   Data      │   │    │    │  ← Repositories, ORM Models
│  │  │  └────────────┘   │    │    │
│  │  └──────────────────┘    │    │
│  └──────────────────────────┘    │
└──────────────────────────────────┘
```

### 2. SOLID Principles

- **S**ingle Responsibility: Each class/module has one reason to change
- **O**pen/Closed: Open for extension, closed for modification
- **L**iskov Substitution: Subtypes must be substitutable for base types
- **I**nterface Segregation: Many specific interfaces over one general
- **D**ependency Inversion: Depend on abstractions, not concretions

### 3. CMDB Project Directory Convention

```
backend/
├── app/
│   ├── api/              # Presentation Layer (Routers)
│   │   └── v1/
│   │       ├── assets.py
│   │       ├── projects.py
│   │       └── relations.py
│   ├── core/             # Application Config & Security
│   │   ├── config.py
│   │   ├── security.py
│   │   └── dependencies.py
│   ├── models/           # Domain & Data Layer (ORM)
│   │   ├── asset.py
│   │   ├── project.py
│   │   └── relation.py
│   ├── schemas/          # Pydantic DTOs (Presentation contracts)
│   │   ├── asset.py
│   │   ├── project.py
│   │   └── relation.py
│   ├── services/         # Application Layer (Business Logic)
│   │   ├── asset_service.py
│   │   ├── relation_service.py
│   │   └── change_service.py
│   ├── db/               # Database session & migrations
│   │   └── session.py
│   └── main.py           # FastAPI app entry point
├── tests/
├── alembic/
└── requirements.txt
```

### 4. Anti-Patterns to REJECT

- ❌ Router directly calling ORM queries (skip service layer)
- ❌ Business logic inside Pydantic models
- ❌ Circular imports between modules
- ❌ God classes with too many responsibilities
- ❌ Raw SQL strings in router handlers
- ❌ Hardcoded configuration values

### 5. Design Patterns to PREFER

- ✅ Repository Pattern for data access
- ✅ Service Layer for business logic orchestration
- ✅ Dependency Injection via FastAPI `Depends()`
- ✅ Factory Pattern for creating complex objects
- ✅ Strategy Pattern for cloud-vendor-specific logic

## Validation Checklist

Before approving any architectural decision:

- [ ] Does it follow Clean Architecture layer boundaries?
- [ ] Are SOLID principles maintained?
- [ ] Is the directory structure consistent with conventions?
- [ ] Are there no anti-patterns present?
- [ ] Is multi-tenancy enforced at the correct layer?
- [ ] Can the component be tested in isolation?
