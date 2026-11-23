// Usage: node scripts/validate.mjs            check the posts and images
//        node scripts/validate.mjs --build DIR  also write the content store layout to DIR/blog
import {fileURLToPath} from 'node:url';
import {validate, build} from './content.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = process.argv.indexOf('--build');
try {
  if (at > 0) {
    const out = process.argv[at + 1];
    if (!out) throw new Error('--build needs a directory');
    const {posts, images} = await build(root, out);
    console.log('Built ' + posts + ' post(s) and ' + images + ' image(s) in ' + out + '/blog');
  } else {
    const {posts, images, errors} = await validate(root);
    if (errors.length) {
      for (const error of errors) console.log('::error::' + error);
      process.exitCode = 1;
    } else console.log('Content is valid: ' + posts.length + ' post(s), ' + images.length + ' image(s)');
  }
} catch (error) {
  console.log('::error::' + error.message.split('\n').join('%0A'));
  process.exitCode = 1;
}
