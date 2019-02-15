'use strict';

const optipng = require('optipng-bin');
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const sharp = require('sharp');
const cp = require('child_process');

// Required fields in the manifest
const requiredFields = ['name', 'emoticons'];
// Pattern to match emoticon files
const fileRe = /^[a-zA-Z0-9_-]*$/;
// Maximum emoticon file size
const maxFileSize = 1024 * 50;
// Emoticon file formats
const formats = ['png', 'gif', 'svg'];


/**
 * Validates a directory of emoticons
 * @param  {String} dir
 * @throws {Error} If invalid
 */
exports.validate = (dir, cb) => {
    say('Checking ' + dir);

    const index = path.join(dir, 'index.json');
    const manifest = require('./' + index);
    const allowedFiles = [index];

    requiredFields.forEach(name => {
        assert(name in manifest);
    });
    say('Verified manifest', 1);

    say('Checking emoticons', 1);
    Object.keys(manifest.emoticons).forEach(code => {
        assert(code.length > 1);

        const emoticon = manifest.emoticons[code];
        const file = emoticon.file;
        assert(fileRe.test(file));
        assert(emoticon.alt);
        assert(emoticon.alt.en);

        say('Looking for ' + file, 2);
        const stat = getFormat(path.join(dir, file));
        if (!stat) {
            assert(false);
        }
        say('Discovered ' + stat.file, 2);

        assert(stat.size < maxFileSize);
        allowedFiles.push(stat.file);
    });

    say('Checking for extraneous files', 1);
    fs.readdirSync(dir).forEach(file => {
        say('Checking ' + file, 2);
        assert(allowedFiles.indexOf(path.join(dir, file)) !== -1);
    });
};

/**
 * Builds a sprite sheet for the emoticons in the target file (png).
 * Returns a parsed menfiest.
 * @param  {Number} size Size in pixels of each image
 * @param  {String} dir
 * @param  {String} target
 * @param  {Function} callback
 */
exports.spritesheet = (size, dir, target, callback) => {
    say('Rendering pack ' + dir);
    const manifest = require('./' + path.join(dir, 'index.json'));
    const codes = Object.keys(manifest.emoticons);

    let unique = 0;
    const seen = [];
    codes.forEach(code => {
        const emoticon = manifest.emoticons[code];
        const f = emoticon.file;
        if (seen.indexOf(f) === -1) {
            seen.push(f);
            unique++;
        }
    });

    const columns = Math.ceil(Math.sqrt(unique));
    const rows = Math.ceil(unique / columns);
    const cached = {};

    // This startingSheet is used once, it just sets up the canvas, we immediately turn it into a buffer.
    // within the first add call.
    const startingSheet = sharp({
        create: {
            width: columns * size,
            height: rows * size,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
    });
    // Sharp uses a pipeline style process, so for each iteration of the sheet processing
    // we need to store and add to a buffer. Here we initialize the buffer to start with 
    // something
    let workingSheetBuffer;
    /**
     * Adds the emoticon's image to the lwip board.
     * @param {Number} x
     * @param {Number} y
     * @param {Function} callback
     */
    function add(filePath, ext, x, y, callback) {
        const file = sharp(filePath)
        .resize(size, size)
        .toBuffer()
        .then(buffer => {
            // Let's workout what we need to overlay
            // If this is the first run through we'll need to use the starting sheet
            // otherwise the working buffer is used.
            let target;
            if (workingSheetBuffer && workingSheetBuffer.length) {
                target = sharp(workingSheetBuffer);
            } else {
                target = startingSheet;
            }
            // Overlay and immediately, turn it back into a buffer
            return target.overlayWith(buffer, {
                top: y, 
                left: x
            }).png().toBuffer()
        })
        .then((data) => {
            // store the buffer for the next iteration
            workingSheetBuffer = data;
        })
        .then(() => callback(null))
        .catch(err => callback(err));
    }

    /**
     * Takes an svg file, and returns a rendered png
     * as a buffer to the callback.
     * @param  {String} file
     * @param {Function} callback
     */
    function grabSvg(file, callback) {
        sharp(file).toBuffer(callback);
    }

    /**
     * Writes out the sprite sheet.
     * @param  {Function} done
     */
    function done () {
        const tmp = target + '.nomin';
        say('Writing out to ' + tmp, 1);
        
        sharp(workingSheetBuffer).png().toFile(tmp)
        .then(info => {
            say('Minifying...', 1);
            cp.execFile(optipng, ['-out', target, tmp], err => {
                if(err) {
                    console.log(err);
                }
                fs.unlinkSync(tmp);
                callback(err, manifest);
            });
        })
        .catch(err => {
            return callback(err);
        });
    }

    /**
     * Recursive function to draw images to the board.
     * @param  {Number}   idx
     */
    (function next (idx, ptr) {
        if (idx >= codes.length) {
            return done();
        }

        const x = size * (ptr % columns);
        const y = size * Math.floor(ptr / columns);

        const code = codes[idx];
        const emoticon = manifest.emoticons[code];
        const filename = emoticon.file;
        const stat = getFormat(path.join(dir, filename));

        if (filename in cached) {
            say('Loading file for `' + code + '` from cache.', 1);
            manifest.emoticons[code] = cached[filename];
            return cb();
        }

        delete manifest.emoticons[code].file;
        manifest.emoticons[code] = cached[filename] = {
            x, y,
            width: size,
            height: size,
            alt: manifest.emoticons[code].alt
        };

        ptr += 1;

       
        say('Drawing ' + stat.file + ' at (' + x + ', ' + y + ')', 1);
        add(stat.file, stat.fmt, x, y, cb);

        function cb (err) {
            if (err) {
                callback(err);
            } else {
                next(idx + 1, ptr);
            }
        }
    })(0, 0);
};

/**
 * Determines the format of a file, and returns a stat for it,
 * including the full file path.
 * @param  {String} file
 * @return {Object}
 */
function getFormat (file) {
    for (let i = 0; i < formats.length; i++) {
        let fmt = formats[i];
        let stat;

        try {
            stat = fs.statSync(file + '.' + fmt);
        } catch (e) {
            continue;
        }

        stat.file = file + '.' + fmt;
        stat.fmt = fmt;
        return stat;
    }
}

/**
 * Wrapper around console.log to print a message.
 * @param  {String} msg
 * @param  {Number} [indent]
 */
function say(msg, indent) {
    while (indent) {
        msg = '\t' + msg;
        indent--;
    }
    console.log(msg);
};
