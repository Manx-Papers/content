// Usage: node scripts/validate.mjs            check the posts and images
//        node scripts/validate.mjs --build DIR  also write the content store layout to DIR/blog
import {fileURLToPath} from 'node:url';
import {validate, build} from './content.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// GitHub workflow-command data escaping, so a file name cannot start a new command line.
const annotate = (text, level = 'error') => console.log('::' + level + '::' + String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'));
const at = process.argv.indexOf('--build');
try {
  if (at > 0) {
    const out = process.argv[at + 1];
    if (!out) throw new Error('--build needs a directory');
    const {posts, images} = await build(root, out);
    console.log('Built ' + posts + ' post(s) and ' + images + ' image(s) in ' + out + '/blog');
  } else {
    const {posts, images, errors, warnings} = await validate(root);
    for (const warning of warnings) annotate(warning, 'warning');
    if (errors.length) {
      for (const error of errors) annotate(error);
      process.exitCode = 1;
    } else console.log('Content is valid: ' + posts.length + ' post(s), ' + images.length + ' image(s)');
  }
} catch (error) {
  annotate(error.message);
  process.exitCode = 1;
}
