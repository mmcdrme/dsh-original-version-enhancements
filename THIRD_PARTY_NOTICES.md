# Third-party notices

The archive search and confirmed session deletion code under `host/` is adapted
from **dsh-chat-manager v1.5.21** (https://github.com/WSL043/dsh-chat-manager),
used under the MIT License:

> MIT License
>
> Copyright (c) 2026 WSL043
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Local differences from the original: the Agent lifecycle tracker is the same
approach as v1.5.21, but sessions loaded before the tracker started have no
retained handle; for those the Client offers an explicit "force delete" that
removes the on-disk record without the persistence write lease and warns that
the in-memory session becomes invalid. The restore path uses the official
Client `workspaces.unarchiveSession` call rather than a Host route.

## automation-console

The automation enhancement panel (`host/automation.mjs` and the matching Client
panel) supersedes the local-only `@local/dsh-automation-console` plugin written by
the same author for this profile, which is not published anywhere and carries no
third-party code. Its features were re-implemented against the current DSH 0.2.x
Schedule service (`schedule.create` / `schedule.edit` task-identity API) because
the original patched a prototype-level Remote descriptor that no longer exists;
no code is copied verbatim from a third party.
