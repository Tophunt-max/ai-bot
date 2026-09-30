# Models

Model cards and metadata will live here. Binary artifacts go to R2 (`models/artifacts/` is git-ignored).
Each model version is registered in D1 `model_versions` and moves through
DRAFT → VALIDATING → PAPER → SHADOW → CANARY → PRODUCTION. A model is never auto-promoted.
