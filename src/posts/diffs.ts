
import validator from 'validator';
import diff from 'diff';

import db from '../database';
import meta from '../meta';
import plugins from '../plugins';
import translator from '../translator';
import topics from '../topics';

type applyfunction = (content: string, aDiff: string) => string;

interface DIFFS {
    exists: (pid: string) => Promise<boolean>;
    get: ((pid: string, since?: string | number) => Promise<any[]>);
    list: (pid: string) => Promise<string[]>;
    save: (data: DATA) => Promise<void>;
    load: (pid: string, since: string, uid: string) => Promise<string>;
    restore: (pid: string, since: string, uid: string, req: string) => Promise<void>;
    delete: (pid: string, timestamp: string, uid: string) => Promise<string[]>;
    reduce: (applyPatch: applyfunction, validator: VALIDATOR) => Promise<number>;
    filter: (d: boolean) => Promise<titleDIFFS>;
}

interface titleDIFFS {
    length: number;
}

interface tagDIFFS {
    length: number;
}

interface VALIDATOR {
    unescape: (number) => Promise<number>;
}

interface DATA {
    pid: string;
    uid: string;
    oldContent: string;
    newContent: string;
    edited: string;
    topic: TOPIC;
}

interface diffDATA {
    uid: string;
    pid: string;
    patch?: string;
    title?: string;
    tags?: string;
}

interface TOPIC {
    renamed: string;
    tagsupdated: string;
    oldTags: string;
    oldTitle: string;
}

interface aDIFF {
    patch?: number;
}

interface POSTS {
    diffs: DIFFS;
    getPostSummaryByPids (pid: string[], uid: string, parse: object);
    edit (o: object);
}



export default function (Posts: POSTS) {
    const Diffs = {} as DIFFS;
    Posts.diffs = Diffs;
    Diffs.exists = async function (pid) {
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        if (meta.config.enablePostHistory !== 1) {
            return false;
        }
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const numDiffs = await db.listLength(`post:${pid}:diffs`) as number;
        return !!numDiffs;
    };

    Diffs.get = async function (pid, since) {
        const timestamps = await Diffs.list(pid);
        if (!since) {
            since = 0;
        }

        // Pass those made after `since`, and create keys
        const keys = timestamps.filter(t => (parseInt(t, 10) || 0) > since)
            .map(t => `diff:${pid}.${t}`);
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        return await db.getObjects(keys) as string[];
    };

    Diffs.list = async function (pid) {
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        return await db.getListRange(`post:${pid}:diffs`, 0, -1) as string[];
    };

    Diffs.save = async function (data) {
        const { pid, uid, oldContent, newContent, edited, topic } = data;
        const editTimestamp = edited || Date.now();
        const diffData : diffDATA = {
            uid: uid,
            pid: pid,
        };
        if (oldContent !== newContent) {
            // The next line calls a function in a module that has not been updated to TS yet
            /* eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,
               @typescript-eslint/no-unsafe-assignment */
            diffData.patch = diff.createPatch('', newContent, oldContent);
        }
        if (topic.renamed) {
            diffData.title = topic.oldTitle;
        }
        if (topic.tagsupdated && Array.isArray(topic.oldTags)) {
            /* eslint-disable max-len */
            diffData.tags = topic.oldTags.map(tag => tag && tag.value).filter(Boolean).join(',');
            /* eslint-enable max-len */
        }
        await Promise.all([
            // The next line calls a function in a module that has not been updated to TS yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
            db.listPrepend(`post:${pid}:diffs`, editTimestamp),
            // The next line calls a function in a module that has not been updated to TS yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
            db.setObject(`diff:${pid}.${editTimestamp}`, diffData),
        ]);
    };


    function getValidatedTimestamp(timestamp: string) {
        const timestamp2 = parseInt(timestamp, 10);

        if (isNaN(timestamp2)) {
            throw new Error('[[error:invalid-data]]');
        }

        return timestamp;
    }

    function applyPatch(content: any, aDiff: aDIFF) {
        if (aDiff && aDiff.patch) {
            const result = diff.applyPatch(content, aDiff.patch, {
                fuzzFactor: 1,
            });
            return typeof result === 'string' ? result : content;
        }
        return content;
    }

    async function postDiffLoad(pid: string, since: string, uid: string) {
        // Retrieves all diffs made since `since` and replays them to reconstruct what the post looked like at `since`
        const [post, diffs] = await Promise.all([
            Posts.getPostSummaryByPids([pid], uid, { parse: false }),
            Posts.diffs.get(pid, since),
        ]);

        // Replace content with re-constructed content from that point in time

        post[0].content = diffs.reduce(applyPatch, validator.unescape(post[0].content));

        const titleDiffs: titleDIFFS = diffs.filter(d => d.hasOwnProperty('title') && d.title);
        if (titleDiffs.length && post[0].topic) {
            post[0].topic.title = validator.unescape(String(titleDiffs[titleDiffs.length - 1].title));
        }
        const tagDiffs: tagDIFFS = diffs.filter(d => d.hasOwnProperty('tags') && d.tags);
        if (tagDiffs.length && post[0].topic) {
            const tags = tagDiffs[tagDiffs.length - 1].tags.split(',').map((tag: any) => ({ value: tag }));
            post[0].topic.tags = await topics.getTagData(tags);
        }

        return post[0];
    }


    Diffs.load = async function (pid, since, uid) {
        since = getValidatedTimestamp(since);
        const post = await postDiffLoad(pid, since, uid);
        post.content = String(post.content || '');

        const result = await plugins.hooks.fire('filter:parse.post', { postData: post });
        result.postData.content = translator.escape(result.postData.content);
        return result.postData;
    };

    Diffs.restore = async function (pid, since, uid, req) {
        const since2 = getValidatedTimestamp(since);
        const post = await postDiffLoad(pid, since, uid);

        return await Posts.edit({
            uid: uid,
            pid: pid,
            content: post.content,
            req: req,
            timestamp: since2,
            title: post.topic.title,
            tags: post.topic.tags.map((tag: { value: any; }) => tag.value),
        });
    };

    Diffs.delete = async function (pid, timestamp, uid) {
        getValidatedTimestamp(timestamp);

        const [post, diffs, timestamps] = await Promise.all([
            Posts.getPostSummaryByPids([pid], uid, { parse: false }),
            Diffs.get(pid),
            Diffs.list(pid),
        ]);

        const timestampIndex = timestamps.indexOf(timestamp);
        const lastTimestampIndex = timestamps.length - 1;

        if (timestamp === String(post[0].timestamp)) {
            // Deleting oldest diff, so history rewrite is not needed
            return Promise.all([
                // The next line calls a function in a module that has not been updated to TS yet
                /* eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,
                   @typescript-eslint/no-unsafe-call */
                db.delete(`diff:${pid}.${timestamps[lastTimestampIndex]}`),
                // The next line calls a function in a module that has not been updated to TS yet
                /* eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,
                   @typescript-eslint/no-unsafe-call */
                db.listRemoveAll(`post:${pid}:diffs`, timestamps[lastTimestampIndex]),
            ]);
        }
        if (timestampIndex === 0 || timestampIndex === -1) {
            throw new Error('[[error:invalid-data]]');
        }

        const postContent = validator.unescape(post[0].content);
        const versionContents = {};
        for (let i = 0, content = postContent; i < timestamps.length; ++i) {
            versionContents[timestamps[i]] = applyPatch(content, diffs[i]);
            content = versionContents[timestamps[i]];
        }

        /* eslint-disable no-await-in-loop */
        for (let i = lastTimestampIndex; i >= timestampIndex; --i) {
            // Recreate older diffs with skipping the deleted diff
            const newContentIndex: number = i === timestampIndex ? i - 2 : i - 1;
            const timestampToUpdate: number = newContentIndex + 1;
            // The next line calls a function in a module that has not been updated to TS yet
            /* eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,
               @typescript-eslint/no-unsafe-call */
            const newContent = newContentIndex < 0 ? postContent : versionContents[timestamps[newContentIndex]] as string;
            const patch = diff.createPatch('', newContent, versionContents[timestamps[i]]);
            // The next line calls a function in a module that has not been updated to TS yet
            /* eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,
               @typescript-eslint/no-unsafe-assignment */
            await db.setObject(`diff:${pid}.${timestamps[timestampToUpdate]}`, { patch }) as string;
        }

        return Promise.all([
            // The next line calls a function in a module that has not been updated to TS yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
            db.delete(`diff:${pid}.${timestamp}`),
            // The next line calls a function in a module that has not been updated to TS yet
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
            db.listRemoveAll(`post:${pid}:diffs`, timestamp),
        ]);
    };
}
