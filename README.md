# TestifySec Action Wrapper

A GitHub Action that downloads and executes another GitHub Action dynamically with optional command wrapping (strace, time, perf, etc.).

## Usage

```yaml
name: Example Workflow
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v3
      - name: Run Nested Action via Wrapper
        uses: testifysec/action-wrapper@v3
        with:
          action-ref: "actions/hello-world-javascript-action@main"
          input-who-to-greet: "World"  # Passed to the nested action as who-to-greet
          wrapper-command: "time -v"   # Wrap with the 'time' command to measure performance
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `action-ref` | Reference to the nested action (e.g., owner/repo@ref) | Yes | |
| `wrapper-command` | Command to wrap around the nested action execution (e.g., 'strace -f', 'time -v', etc.) | No | `strace -f -v -s 256 -e trace=file,process,network,signal,ipc,desc,memory` |
| `enable-wrapper` | Enable command wrapping | No | `true` |
| `input-*` | Any input with the prefix `input-` will be passed to the nested action | No | |
| `extra-args` | Extra arguments to pass to the nested action (deprecated, use `input-*` instead) | No | |
| `strace-options` | Options to pass to strace (deprecated, use `wrapper-command` instead) | No | |
| `enable-strace` | Enable strace instrumentation (deprecated, use `enable-wrapper` instead) | No | |

### Passing Inputs to Nested Actions

To pass inputs to the nested action, prefix them with `input-`. For example:

- `input-who-to-greet: "World"` will be passed to the nested action as `who-to-greet: "World"`
- `input-token: ${{ secrets.GITHUB_TOKEN }}` will be passed as `token: ${{ secrets.GITHUB_TOKEN }}`

## Outputs

| Output | Description |
|--------|-------------|
| `wrapper-log` | Path to the output log file for the wrapper command. The filename includes timestamp and action name for easy identification. |
| `strace-log` | Path to the strace log file (deprecated, use `wrapper-log` instead). |

## Features

- **Any Command Wrapper**: Wrap actions with any command (strace, time, perf, ltrace, valgrind, etc.)
- **Flexible Reference Handling**: Supports both tags (e.g., `v1.0.0`) and branch names (e.g., `main`)
- **Smart Extraction**: Intelligently finds the extracted directory even if naming patterns change
- **Format Flexibility**: Supports both `action.yml` and `action.yaml` metadata files
- **Robust Error Handling**: Attempts alternative download URLs if the first one fails
- **Dependency Management**: Automatically installs dependencies for the wrapped action
- **Command Output Logging**: Automatically captures command output to log files when appropriate

## How It Works

1. **Parsing the Input:**  
   The wrapper reads an input `action-ref` (like `"owner/repo@ref"`) and splits it into the repository identifier and ref.

2. **Downloading the Repository:**  
   It constructs the URL for the GitHub zip archive, automatically handling both branch and tag references. The zip is then downloaded using Axios and extracted using the `unzipper` package into a temporary directory.

3. **Reading Action Metadata:**  
   The script reads the action's metadata file (either `action.yml` or `action.yaml`) from the extracted folder to determine the JavaScript entry point (from the `runs.main` field).

4. **Dependency Installation (Optional):**  
   If a `package.json` is present in the nested action, it runs `npm install` to install dependencies.

5. **Command Wrapping (Optional):**  
   If a wrapper command is enabled, the action runs the nested action with the specified command wrapped around it (e.g., strace, time, perf, etc.).

6. **Executing the Nested Action:**  
   Finally, the wrapper runs the nested action's entry file using Node.js with any provided inputs.

## Examples

### Using with a Performance Timer

```yaml
- name: Run with Time Measurements
  id: time-action
  uses: testifysec/action-wrapper@v3
  with:
    action-ref: "actions/hello-world-javascript-action@main"
    wrapper-command: "time -v"
    input-who-to-greet: "World"

- name: Upload Time Results
  uses: actions/upload-artifact@v4
  with:
    name: time-logs
    path: ${{ steps.time-action.outputs.wrapper-log }}
```

### Using with System Call Tracing (Strace)

```yaml
- name: Run with Strace
  id: strace-action
  uses: testifysec/action-wrapper@v3
  with:
    action-ref: "actions/hello-world-javascript-action@main"
    wrapper-command: "strace -f -v -s 256 -e trace=file,process,network,signal,ipc,desc,memory"
    input-who-to-greet: "World"

- name: Upload Strace Results
  uses: actions/upload-artifact@v4
  with:
    name: strace-logs
    path: ${{ steps.strace-action.outputs.wrapper-log }}
```

### Using with Memory Profiling (Valgrind)

```yaml
- name: Run with Valgrind
  id: valgrind-action
  uses: testifysec/action-wrapper@v3
  with:
    action-ref: "actions/hello-world-javascript-action@main"
    wrapper-command: "valgrind --tool=memcheck --leak-check=full --show-leak-kinds=all"
    input-who-to-greet: "World"

- name: Upload Valgrind Results
  uses: actions/upload-artifact@v4
  with:
    name: valgrind-logs
    path: ${{ steps.valgrind-action.outputs.wrapper-log }}
```

### Using with Linux Performance Counters (Perf)

```yaml
- name: Run with Perf
  id: perf-action
  uses: testifysec/action-wrapper@v3
  with:
    action-ref: "actions/hello-world-javascript-action@main"
    wrapper-command: "perf stat -e cycles,instructions,cache-references,cache-misses"
    input-who-to-greet: "World"

- name: Upload Perf Results
  uses: actions/upload-artifact@v4
  with:
    name: perf-logs
    path: ${{ steps.perf-action.outputs.wrapper-log }}
```

### Running Without Any Wrapper

```yaml
- name: Run Direct (No Wrapper)
  uses: testifysec/action-wrapper@v3
  with:
    action-ref: "actions/hello-world-javascript-action@main"
    enable-wrapper: "false"
    input-who-to-greet: "World"
```