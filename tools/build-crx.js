import {$} from 'execa';
import glob from 'tiny-glob';

const zipPath = (await glob('web-ext-artifacts/bookmark*.zip')).pop();

await $({stdin: {file: zipPath}})`crx3 -p key.pem -o ${zipPath.replace('.zip', '.crx')}`;
