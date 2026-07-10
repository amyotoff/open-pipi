import path from 'node:path';
import { formatContentCheckReport, listSkillCapabilityIds, validateContentRoots } from '../core/content-validator';

export function isContentCheckCli(argvEntry = process.argv[1], moduleFile = __filename): boolean {
    return require.main === module || Boolean(argvEntry && path.resolve(argvEntry) === path.resolve(moduleFile));
}

if (isContentCheckCli()) {
    const cwd = process.cwd();
    const checks = validateContentRoots(
        {
            packs: path.join(cwd, 'src', 'packs'),
            groundings: path.join(cwd, 'src', 'groundings'),
        },
        listSkillCapabilityIds(path.join(cwd, 'src', 'skills'))
    );
    const valid = !checks.some((item) => item.status === 'fail');

    if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ valid, checks }, null, 2));
    } else {
        console.log(formatContentCheckReport(checks));
    }
    if (!valid) process.exitCode = 1;
}
