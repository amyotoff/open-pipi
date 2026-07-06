import { PackToolRuntimeSnapshot } from './pack-types';
import { RuntimeExecutionContext } from './runtime-context';
import { SandboxExecutionSpec } from './tool-execution';

export interface SandboxPackToolRequest {
    tool_name: string;
    project_root: string;
    relative_tool_path: string;
    tool_args: any;
    runtime: PackToolRuntimeSnapshot;
    context: RuntimeExecutionContext;
    sandbox?: SandboxExecutionSpec;
    workspace_root?: string | null;
    relative_workspace_path?: string | null;
}

export interface SandboxPackToolResponse {
    ok: true;
    text: string;
    metadata: {
        backend: 'docker';
        image: string;
        container_id: string | null;
        output_dir: string;
        files_written: string[];
        duration_ms: number;
    };
}

export interface SandboxErrorResponse {
    ok: false;
    error: string;
}
