import { Listener as IListener } from '../types/Listener';
import {
  Context,
  AppIntent,
  AppMetadata,
  IntentMetadata,
  TargetApp,
  IntentResolution,
} from '@finos/fdc3';
import { FDC3Message } from '../types/FDC3Message';
import {
  ChannelData,
  DirectoryApp,
  FDC3App,
  FDC3AppDetail,
  IntentInstance,
} from '../types/FDC3Data';
import utils from '../utils';
import { View } from '../view';
import { getRuntime } from '../index';
import { Runtime } from '../runtime';
import { ipcMain } from 'electron';
import fetch from 'electron-fetch';
import { TOPICS } from '../constants';
import { FDC3Listener } from '../types/FDC3Listener';
import { Pending } from '../types/Pending';

/**
 * represents an event listener
 */
interface Listener {
  appId: string;
  contextType?: string;
  isChannel?: boolean;
  listenerId: string;
}

//wait 2 minutes for pending intents to connect
const pendingTimeout: number = 2 * 60 * 1000;

// map of all running contexts keyed by channel
//const contexts : Map<string,Array<Context>> = new Map([["default",[]]]);

//map of listeners for each context channel
//const contextListeners : Map<string,Map<string,Listener>> = new Map([["default",new Map()]]);
//make a separate map of instance listeners,
//this would just be for handling point-to-point context transfer
const instanceListeners: Map<string, Map<string, Listener>> = new Map();

//collection of app channel ids
const app_channels: Array<ChannelData> = [];

//generate / get full channel object from an id - returns null if channel id is not a system channel or a registered app channel
const getChannelMeta = (id: string): ChannelData | null => {
  let channel: ChannelData | null = null;
  //is it a system channel?
  const sChannels: Array<ChannelData> = utils.getSystemChannels();
  const sc = sChannels.find((c) => {
    return c.id === id;
  });

  if (sc) {
    channel = { id: id, type: 'system', displayMetadata: sc.displayMetadata };
  }
  //is it already an app channel?
  if (!channel) {
    const ac = app_channels.find((c) => {
      return c.id === id;
    });
    if (ac) {
      channel = { id: id, type: 'app' };
    }
  }
  return channel;
};

const _listeners: Array<IListener> = [];

_listeners.push({
  name: TOPICS.FDC3_DROP_CONTEXT_LISTENER,
  handler: (runtime: Runtime, msg): Promise<void> => {
    //remove the listener from the view when it is unsubscribed
    return new Promise((resolve, reject) => {
      try {
        const id: string | null = (msg.data && msg.data.id) || null;
        const view: View | null | undefined = msg.source
          ? runtime.getView(msg.source)
          : null;
        if (view) {
          view.listeners = view.listeners.filter((l: FDC3Listener) => {
            return l.listenerId !== id;
          });
        }

        resolve();
      } catch (err) {
        reject(err);
      }
    });
  },
});

_listeners.push({
  name: TOPICS.FDC3_GET_CURRENT_CONTEXT,
  handler: (runtime, msg): Promise<Context | null> => {
    return new Promise((resolve, reject) => {
      try {
        const channel: string | undefined =
          (msg.data && msg.data.channel) || undefined;
        const type: string | undefined =
          (msg.data && msg.data.contextType) || undefined;
        const contexts = getRuntime().getContexts();
        let ctx: Context | null = null;
        if (channel) {
          const channelContext = contexts.get(channel);
          if (type && channelContext) {
            ctx =
              channelContext.find((c) => {
                return c.type === type;
              }) || null;
          } else if (channelContext) {
            ctx = channelContext[0] ? channelContext[0] : ctx;
          }
        }
        resolve(ctx);
      } catch (err) {
        reject(err);
      }
    });
  },
});

_listeners.push({
  name: TOPICS.FDC3_BROADCAST,
  handler: (runtime: Runtime, msg): Promise<void> => {
    return new Promise((resolve, reject) => {
      const contexts = runtime.getContexts();
      const source = msg.source ? runtime.getView(msg.source) : null;
      try {
        //if there is an instanceId provided on the message - this is the instance target of the broadcast
        //meaning this is a point-to-point com between two instances
        //if the target listener is registered for the source instance, then dispatch the context
        //else, add to the pending queue for instances
        const targetId: string | undefined =
          (msg.data && msg.data.instanceId) || undefined;
        if (targetId) {
          console.log(
            `broadcast message = '${JSON.stringify(
              msg,
            )}' target = '${targetId}' source = '${msg.source}'`,
          );
          let setPending = false;
          const target = runtime.getView(targetId);
          const viewListeners: Array<ViewListener> = [];
          if (target) {
            target.listeners.forEach((l: FDC3Listener) => {
              if (!l.intent) {
                if (
                  !l.contextType ||
                  (l.contextType &&
                    l.contextType === msg.data &&
                    msg.data.context &&
                    msg.data.context.type)
                ) {
                  viewListeners.push({
                    view: target,
                    listenerId: l.listenerId,
                  });
                }
              }
            });
            if (viewListeners.length > 0) {
              viewListeners.forEach((viewL: ViewListener) => {
                const data = {
                  listenerId: viewL.listenerId,
                  eventId: msg.data && msg.data.eventId,
                  ts: msg.data && msg.data.ts,
                  context: msg.data && msg.data.context,
                };
                viewL.view.content.webContents.send(TOPICS.FDC3_CONTEXT, {
                  topic: 'context',
                  listenerId: viewL.listenerId,
                  data: data,
                  source: msg.source,
                });
              });
            } else {
              setPending = true;
            }
          }
          const pendingContext = msg.data && msg.data.context;
          if (setPending && pendingContext && target) {
            target.setPendingContext(pendingContext);
          }
          //if we have a target, we aren't going to go to other channnels - so resolve
          resolve();
        }

        //use channel on message first - if one is specified
        const channel =
          (msg.data && msg.data.channel) ||
          (source && source.channel) ||
          'default';

        if (channel !== 'default') {
          //is the app on a channel?
          // update the channel state
          const channelContext = contexts.get(channel);
          const context = msg.data && msg.data.context;
          if (channelContext && context) {
            channelContext.unshift(context);
          }

          //if there is a channel, filter on channel
          //to filter on channel, check the listener channel andthe view channel (its channel member)
          //loop through all views
          runtime.getViews().forEach((v: View) => {
            //for each view, aggregate applicable listener ids
            //listener must match on channel and context type
            const viewListeners: Array<string> = [];
            v.listeners.forEach((l: FDC3Listener) => {
              console.log('viewListener (1st pass)', l);
              const matchChannel =
                l.channel && l.channel !== 'default'
                  ? l.channel
                  : v.channel
                  ? v.channel
                  : 'default';
              if (matchChannel === channel) {
                console.log(
                  'broadcast - matched channel, contextType ',
                  l.contextType,
                );
                const contextType =
                  msg.data && msg.data.context && msg.data.context.type;
                if (l.contextType && contextType) {
                  console.log(
                    'contextType match',
                    l.contextType === contextType,
                  );
                  if (
                    l.contextType === contextType &&
                    viewListeners.indexOf(l.listenerId) === -1
                  ) {
                    viewListeners.push(l.listenerId);
                  }
                } else if (viewListeners.indexOf(l.listenerId) === -1) {
                  console.log('push listener ', l.listenerId);
                  viewListeners.push(l.listenerId);
                }
              }
            });
            //if there are listeners found, broadcast the context to the view (with all listenerIds)
            if (viewListeners.length > 0) {
              v.content.webContents.send(TOPICS.FDC3_CONTEXT, {
                topic: 'context',
                listenerIds: viewListeners,
                data: {
                  eventId: msg.data && msg.data.eventId,
                  ts: msg.data && msg.data.ts,
                  context: msg.data && msg.data.context,
                },
                source: msg.source,
              });
            }
          });
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  },
});

interface ViewListener {
  view: View;
  listenerId: string;
}

/**
 *
 * @param target
 * Given a TargetApp input, return the app Name or undefined
 */
const resolveTargetAppToName = (target: TargetApp): string | undefined => {
  if (!target) {
    return undefined;
  } else {
    let name = undefined;
    //is target typeof string?  if so, it is just going to be an app name
    if (typeof target === 'string') {
      name = target;
    } else {
      const app: AppMetadata = target as AppMetadata;
      if (app && app.name) {
        name = app.name;
      }
    }
    return name;
  }
};

/**
 *
 * @param target
 * Given a TargetApp input, return a search query string to append to an appD search call
 * e.g.  '&name=AppName' or '&text=AppTitle'
 */
const resolveTargetAppToQuery = (target: TargetApp): string => {
  if (!target) {
    return '';
  } else {
    let query = '';
    //is there a valid app name?
    const name = resolveTargetAppToName(target);
    if (name) {
      query = `&name=${name}`;
    } else {
      const app: AppMetadata = target as AppMetadata;
      if (app) {
        //construct a text search, prefering id, then title, then description
        //this is currently punting on a more complicated heuristic on potentailly ambiguous results (by version, etc)
        if (app.appId) {
          query = `&text=${app.appId}`;
        } else if (app.title) {
          query = `&text=${app.title}`;
        } else if (app.description) {
          query = `&text=${app.description}`;
        }
      }
    }
    return query;
  }
};

_listeners.push({
  name: TOPICS.FDC3_OPEN,
  handler: (runtime, msg): Promise<void> => {
    return new Promise((resolve, reject) => {
      console.log('fdc3Message recieved', msg);

      const name =
        msg.data && msg.data.name
          ? msg.data.name
          : msg.data && msg.data.target
          ? resolveTargetAppToName(msg.data.target)
          : '';
      console.log('open name', name);
      runtime.fetchFromDirectory(`/apps/${name}`).then(
        (result) => {
          result = result as DirectoryApp;
          console.log('directory result', result);
          // const source = utils.id(port);
          if (result) {
            if (result && result.start_url) {
              //get target workspace
              const sourceView = runtime.getView(msg.source);
              const work =
                runtime.getWorkspace(msg.source) ||
                (sourceView && sourceView.parent);
              const newView =
                work &&
                work.createView(result.start_url, { directoryData: result });

              //set provided context
              if (newView && msg.context) {
                newView.setPendingContext(msg.context, msg.source);
              }
              //resolve with the window identfier
              resolve();
              //reject?
            }
          }
        },
        (err) => {
          reject(err);
        },
      );
    });
  },
});

_listeners.push({
  name: TOPICS.FDC3_GET_CURRENT_CONTEXT,
  handler: (runtime, msg): Promise<Context | null> => {
    return new Promise((resolve, reject) => {
      try {
        const channel = (msg.data && msg.data.channel) || undefined;
        const type = (msg.data && msg.data.contextType) || undefined;
        let ctx: Context | null = null;
        if (channel) {
          const contexts = runtime.getContexts();
          const channelContext = contexts.get(channel);
          if (type) {
            if (channelContext) {
              ctx =
                channelContext.find((c) => {
                  return c.type === type;
                }) || null;
            }
          } else {
            ctx = channelContext && channelContext[0] ? channelContext[0] : ctx;
          }
        }
        resolve(ctx);
      } catch (err) {
        reject(err);
      }
    });
  },
});

_listeners.push({
  name: TOPICS.FDC3_GET_OR_CREATE_CHANNEL,
  handler: (runtime, msg): Promise<ChannelData | void> => {
    return new Promise((resolve, reject) => {
      const id = (msg.data && msg.data.channelId) || 'default';
      //reject with error is reserved 'default' term
      if (id === 'default') {
        reject(utils.ChannelError.CreationFailed);
      } else {
        let channel: ChannelData | null = getChannelMeta(id);

        //if not found... create as an app channel
        if (!channel) {
          channel = { id: id, type: 'app' };
          //add an entry for the context listeners
          //contextListeners.set(id, new Map());
          runtime.getContexts().set(id, []);
          app_channels.push(channel);
        }
        if (channel) {
          resolve(channel);
        } else {
          resolve();
        }
      }
    });
  },
});

/**
 * Each View object has its own collection of listeners
 */
_listeners.push({
  name: TOPICS.FDC3_ADD_CONTEXT_LISTENER,
  handler: (runtime: Runtime, msg): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      try {
        const source = msg.source; //this is the app instance calling addContextListener

        //if there is an instanceId specified, this call is to listen to context from a specific app instance
        const view = runtime.getView(msg.source);
        const listenerId = msg.data && msg.data.id;
        console.log('listenerId', listenerId);
        const instanceId = msg.data && msg.data.instanceId;
        if (instanceId && view) {
          console.log(
            'addContextLister ',
            msg.data && msg.data.id,
            instanceId,
            instanceListeners,
          );
          const target: View | undefined = runtime.getView(instanceId);
          if (target) {
            //add a listener for the specific target (instanceId)
            target.listeners.push({
              viewId: view.id,
              source: instanceId,
              listenerId: (msg.data && msg.data.id) || '',
              contextType: (msg.data && msg.data.contextType) || '',
            });
            const pendingContexts = target.getPendingContexts();
            if (pendingContexts && pendingContexts.length > 0) {
              pendingContexts.forEach((pending, i) => {
                //does the source of the pending context match the target?
                if (pending && pending.source && pending.source === view.id) {
                  //is there a match on contextType (if specified...)
                  if (
                    pending.context &&
                    pending.context.type &&
                    pending.context.type === msg.data &&
                    msg.data.type
                  ) {
                    view.content.webContents.postMessage(TOPICS.FDC3_CONTEXT, {
                      topic: 'context',
                      data: pending.context,
                      source: source,
                    });
                    target.removePendingContext(i);
                  }
                }
              });
            }
          }
          resolve(true);
        }

        //use channel from the event message first, or use the channel of the sending app, or use default
        const channel: string =
          msg.data && msg.data.channel
            ? msg.data.channel
            : view && view.channel
            ? view.channel
            : 'default'; //: (c && c.channel) ? c.channel

        if (view) {
          console.log('adding listener', msg.data && msg.data.id);

          view.listeners.push({
            listenerId: (msg.data && msg.data.id) || '',
            viewId: view.id,
            contextType: (msg.data && msg.data.contextType) || undefined,
            channel: channel,
            isChannel: channel !== 'default',
          });
          console.log('view listeners', view.listeners);

          /*
              are there any pending contexts for the listener just added? 
              */
          const pending = view.getPendingContexts();
          console.log('got pending contexts', pending);
          if (pending && pending.length > 0) {
            pending.forEach((pending: Pending, i: number) => {
              //is there a match on contextType (if specified...)
              console.log(
                'check pending',
                pending.context,
                pending.context ? pending.context.type : 'no pending object',
                msg.data && msg.data.type,
                msg.data && msg.data.id,
                (msg.data && msg.data.type === undefined) ||
                  (pending.context &&
                    pending.context.type &&
                    pending.context.type === msg.data &&
                    msg.data.type) ||
                  '',
              );
              if (
                msg.data === undefined ||
                (msg.data && msg.data.type === undefined) ||
                (pending.context &&
                  pending.context.type &&
                  pending.context.type === msg.data &&
                  msg.data.type)
              ) {
                view.content.webContents.send(TOPICS.FDC3_CONTEXT, {
                  topic: 'context',
                  listenerId: msg.data && msg.data.id,
                  data: {
                    context: pending.context,
                    listenerId: msg.data && msg.data.id,
                  },
                  source: source,
                });

                view.removePendingContext(i);
              }
            });
          }
        }

        resolve(true);
      } catch (err) {
        reject(err);
      }
    });
  },
});

_listeners.push({
  name: TOPICS.FDC3_GET_SYSTEM_CHANNELS,
  handler: (): Promise<Array<ChannelData>> => {
    return new Promise((resolve) => {
      resolve(utils.getSystemChannels());
    });
  },
});

_listeners.push({
  name: TOPICS.FDC3_LEAVE_CURRENT_CHANNEL,
  handler: (runtime, msg): Promise<void> => {
    return new Promise((resolve, reject) => {
      //'default' means we have left all channels
      const view = runtime.getView(msg.source);
      if (view) {
        joinViewToChannel('default', view);
        resolve();
      } else {
        reject('View not found');
      }
    });
  },
});

_listeners.push({
  name: TOPICS.FDC3_ADD_INTENT_LISTENER,
  handler: (runtime, msg): Promise<void> => {
    return new Promise((resolve, reject) => {
      const name = msg.data && msg.data.intent;
      const listenerId = msg.data && msg.data.id;
      if (name && listenerId) {
        try {
          runtime.setIntentListener(name, listenerId, msg.source);
          const view = runtime.getView(msg.source);
          if (view) {
            //check for pending intents
            const pending_intents = view.getPendingIntents();
            if (pending_intents.length > 0) {
              //first cleanup anything old
              const n = Date.now();

              //next, match on tab and intent
              pending_intents.forEach((pIntent, index) => {
                if (
                  n - pIntent.ts < pendingTimeout &&
                  pIntent.intent === name
                ) {
                  console.log('applying pending intent', pIntent);
                  //refactor with other instances of this logic
                  if (view && view.content) {
                    view.content.webContents.send(TOPICS.FDC3_INTENT, {
                      topic: 'intent',
                      data: {
                        intent: pIntent.intent,
                        context: pIntent.context,
                      },
                      source: pIntent.source,
                    });
                  }
                  //bringing the tab to front conditional on the type of intent
                  /* if (! utils.isDataIntent(pIntent.intent)){
                                  utils.bringToFront(port.sender.tab);
                              }*/
                  //remove the applied intent
                  view.removePendingIntent(index);
                }
              });
            }
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      } else {
        reject('No intent name and/or listener id provided');
      }
    });
  },
});
export const joinViewToChannel = (
  channel: string,
  view: View,
  restoreOnly?: boolean,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    console.log('joinViewToChannel', channel);
    const runtime = getRuntime();
    try {
      //get the previous channel
      const prevChan = view.channel || 'default';
      //are the new channel and previous the same?  then no-op...
      if (prevChan !== channel) {
        //update channel membership on view
        view.channel = channel;

        //push current channel context
        //if there is a context...
        const contexts = runtime.getContexts();
        const channelContext = contexts.get(channel);
        if (channelContext) {
          const ctx = channelContext.length > 0 ? channelContext[0] : null;
          let contextSent = false;

          if (ctx && (restoreOnly === undefined || !restoreOnly)) {
            // send to individual listenerIds

            view.listeners.forEach((l) => {
              //if this is not an intent listener, and not set for a specific channel, and not set for a non-matching context type  - send the context to the listener
              if (!l.intent) {
                if (
                  (!l.channel ||
                    l.channel === 'default' ||
                    (l.channel && l.channel === channel)) &&
                  (!l.contextType ||
                    (l.contextType && l.contextType === ctx.type))
                ) {
                  view.content.webContents.send(TOPICS.FDC3_CONTEXT, {
                    topic: 'context',
                    listenerIds: [l.listenerId],
                    data: { context: ctx, listenerId: l.listenerId },
                    source: view.id,
                  });
                  contextSent = true;
                }
              }
            });
            if (!contextSent) {
              //note: the source for this context is the view itself - since this was the result of being joined to the channel (not context being broadcast from another view)
              console.log(
                'setPendingContext',
                channelContext && channelContext[0],
              );
              view.setPendingContext(channelContext && channelContext[0]);
            }
          }
        }
      }

      resolve();
    } catch (err) {
      reject(err);
    }
  });
};

_listeners.push({
  name: TOPICS.FDC3_JOIN_CHANNEL,
  handler: (runtime, msg): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      const channel = msg.data && msg.data.channel;
      if (channel) {
        try {
          const view = runtime.getView(msg.source);
          if (view) {
            joinViewToChannel(
              channel,
              view,
              (msg.data && msg.data.restoreOnly) || undefined,
            ).then(
              () => {
                resolve(true);
              },
              () => {
                resolve(false);
              },
            );
          }
        } catch (err) {
          reject(err);
        }
      } else {
        reject('No channel provided');
      }
    });
  },
});

_listeners.push({
  name: TOPICS.JOIN_WORKSPACE_TO_CHANNEL,
  handler: (runtime, msg): Promise<boolean> => {
    console.log('join workspace to channel');
    return new Promise((resolve, reject) => {
      //get collection of views for the window
      const channel = msg.data && msg.data.channel;
      if (channel) {
        try {
          const workspace = runtime.getWorkspace(msg.source);
          if (workspace) {
            workspace.setChannel(channel);
            resolve(true);
          } else {
            resolve(false);
          }
        } catch (err) {
          reject(err);
        }
      } else {
        reject('No channel provided');
      }
    });
  },
});

_listeners.push({
  name: TOPICS.FDC3_FIND_INTENT,
  handler: (runtime, msg): Promise<AppIntent> => {
    return new Promise((resolve, reject) => {
      const intent = msg.data && msg.data.intent;
      const context = msg.data && msg.data.context;
      if (intent) {
        let url = `/apps/search?intent=${intent}`;
        if (context) {
          url += `&context=${context.type}`;
        }

        runtime.fetchFromDirectory(url).then(
          (_r) => {
            const j: Array<DirectoryApp> = _r as Array<DirectoryApp>;
            let r: AppIntent = {
              intent: { name: '', displayName: '' },
              apps: [],
            };

            // r.apps = j;
            //find intent display name from app directory data
            const intnt = j[0].intents.filter((i) => {
              return i.name === intent;
            });
            if (intnt.length > 0) {
              r = {
                intent: {
                  name: intnt[0].name,
                  displayName: intnt[0].display_name,
                },
                apps: [],
              };
            }
            j.forEach((dirApp) => {
              r.apps.push({
                name: dirApp.name,
                title: dirApp.title,
                description: dirApp.description,
                icons: dirApp.icons.map((icon) => {
                  return icon.icon;
                }),
              });
            });
            resolve(r as AppIntent);
          },
          () => {
            //no results found for the app-directory, there may still be intents from live apps
            resolve({ intent: { name: intent, displayName: '' }, apps: [] });
          },
        );
      } else {
        reject('no intent');
      }
    });
  },
});

_listeners.push({
  name: TOPICS.FDC3_FIND_INTENTS_BY_CONTEXT,
  handler: (runtime, msg): Promise<Array<AppIntent>> => {
    return new Promise((resolve, reject) => {
      const context = msg.data && msg.data.context;
      if (context && context.type) {
        console.log('findIntentsByContext', context.type);
        const url = `/apps/search?context=${context.type}`;
        runtime.fetchFromDirectory(url).then(
          (_r) => {
            const d: Array<DirectoryApp> = _r as Array<DirectoryApp>;
            const r: Array<AppIntent> = [];
            if (d) {
              const found: Map<string, Array<AppMetadata>> = new Map();
              const intents: Array<IntentMetadata> = [];
              d.forEach((item) => {
                const appMeta: AppMetadata = {
                  name: item.name,
                  title: item.title,
                  description: item.description,
                  icons: item.icons.map((icon) => {
                    return icon.icon;
                  }),
                };

                item.intents.forEach((intent) => {
                  if (!found.has(intent.name)) {
                    intents.push({
                      name: intent.name,
                      displayName: intent.display_name,
                    });
                    found.set(intent.name, [appMeta]);
                  } else {
                    const apps = found.get(intent.name);
                    if (apps) {
                      apps.push(appMeta);
                    }
                  }
                });
              });

              intents.forEach((intent) => {
                const apps = found.get(intent.name);
                const entry: AppIntent = { intent: intent, apps: apps || [] };
                r.push(entry);
              });
            }
            resolve(r);
          },
          (err) => {
            reject(err);
          },
        );
      } else {
        reject('no context provided');
      }
    });
  },
});

_listeners.push({
  name: TOPICS.FDC3_GET_CURRENT_CHANNEL,
  handler: (runtime, msg): Promise<ChannelData | null> => {
    return new Promise((resolve, reject) => {
      try {
        const c = runtime.getView(msg.source);
        //get the  channel
        const chan = c && c.channel ? getChannelMeta(c.channel) : null;
        resolve(chan);
      } catch (err) {
        reject(err);
      }
    });
  },
});

const resolveIntent = (msg: FDC3Message): Promise<IntentResolution> => {
  return new Promise((resolve, reject) => {
    //find the app to route to
    try {
      const sView =
        msg.selected && msg.selected.details && msg.selected.details.instanceId
          ? getRuntime().getView(msg.selected.details.instanceId)
          : null;
      const source = msg.source;
      if (msg.intent) {
        const listeners = getRuntime().getIntentListeners(msg.intent);
        //let keys = Object.keys(listeners);
        let appId: string | undefined = undefined;
        const id = (sView && sView.id) || undefined;
        listeners.forEach((listener) => {
          if (listener.source === id) {
            appId = listener.source;
          }
        });

        if (appId) {
          console.log('send intent from source', source);
          const app = getRuntime().getView(appId);
          if (app && app.content) {
            app.content.webContents.send(TOPICS.FDC3_INTENT, {
              topic: 'intent',
              data: { intent: msg.intent, context: msg.context },
              source: source,
            });
            //bringing the tab to front conditional on the type of intent
            /*if (! utils.isDataIntent(msg.intent)){
                          utils.bringToFront(appId); 
                      }*/
            if (sView && sView.parent && sView.parent.window) {
              sView.parent.window.webContents.send(TOPICS.SELECT_TAB, {
                viewId: sView.id,
              });
              const id = (sView && sView.id) || null;
              const appName: string = sView.directoryData
                ? sView.directoryData.name
                : 'unknown';
              resolve({
                source: {
                  name: appName,
                  title: sView.getTitle(),
                  appId: id || '',
                },
                version: '1.2',
              });
            }
          }

          //keep array of pending, id by url,  store intent & context, timestamp
          //when a new window connects, throw out anything more than 2 minutes old, then match on url
        }
      }
    } catch (err) {
      reject(err);
    }
  });
};

/*_listeners.push({
  name: TOPICS.FDC3_GET_APP_INSTANCE,
  handler: (runtime, msg) => {
    return new Promise((resolve, reject) => {
      const instance = runtime.getView(msg.data.instanceId);
      if (instance) {
        resolve({ instanceId: instance.id, status: 'ready' });
      } else {
        reject();
      }
    });
  },
});*/

_listeners.push({
  name: TOPICS.FDC3_RAISE_INTENT,
  handler: (runtime, msg): Promise<IntentResolution> => {
    return new Promise((resolve, reject) => {
      const r: Array<FDC3App> = [];

      //handle the resolver UI closing
      /*  port.onMessage.addListener(async (msg : FDC3Message) => {
                if (msg.topic === "resolver-close"){
                    resolve(null);
                }
            });*/

      //decorate the message with source of the intent
      /*  msg.source = utils.id(port);*/

      //add dynamic listeners from connected tabs
      const intent = msg.data && msg.data.intent;
      if (intent) {
        //only support string targets for now...
        const target: string | undefined =
          msg.data && msg.data.target && typeof msg.data.target === 'string'
            ? msg.data.target
            : undefined;
        const intentListeners = runtime.getIntentListeners(intent, target);

        const sourceView = runtime.getView(msg.source);
        const sourceName =
          sourceView && sourceView.directoryData
            ? sourceView.directoryData.name
            : 'unknown';

        console.log('intentListeners', intentListeners);
        if (intentListeners) {
          // let keys = Object.keys(intentListeners);
          intentListeners.forEach((listener) => {
            ///ignore listeners from the view that raised the intent
            if (listener.viewId && listener.viewId !== msg.source) {
              //look up the details of the window and directory metadata in the "connected" store
              const view = runtime.getView(listener.viewId);
              //de-dupe
              if (
                view &&
                !r.find((item) => {
                  return item.details.instanceId === view.id;
                })
              ) {
                r.push({
                  type: 'window',
                  details: {
                    instanceId: view.id,
                    directoryData: view.directoryData,
                  },
                });
              }
            }
          });
        }
        //pull intent handlers from the directory
        let ctx = '';
        if (msg.data && msg.data.context) {
          ctx = msg.data.context.type;
        }
        utils.getDirectoryUrl().then(async (directoryUrl) => {
          const query =
            msg.data && msg.data.target
              ? resolveTargetAppToQuery(msg.data.target)
              : '';

          const _r = await fetch(
            `${directoryUrl}/apps/search?intent=${intent}&context=${ctx}${query}`,
          );
          //console.log('raiseIntent', _r);
          if (_r) {
            let data = null;
            try {
              data = await _r.json();
            } catch (err) {
              console.log('error parsing json', err);
            }

            if (data) {
              data.forEach((entry: DirectoryApp) => {
                r.push({
                  type: 'directory',
                  details: { directoryData: entry },
                });
              });
            }
          }

          if (r.length > 0) {
            if (r.length === 1) {
              //if there is only one result, use that
              //if it is an existing view, post a message directly to it
              //if it is a directory entry resolve the destination for the intent and launch it
              //dedupe window and directory items
              if (
                r[0].type === 'window' &&
                r[0].details &&
                r[0].details.instanceId
              ) {
                const view = runtime.getView(r[0].details.instanceId);
                if (view) {
                  view.content.webContents.send(TOPICS.FDC3_INTENT, {
                    topic: 'intent',
                    data: msg.data,
                    source: msg.source,
                  });
                  //bringing the tab to front conditional on the type of intent
                  if (!utils.isDataIntent(intent)) {
                    /* utils.bringToFront(r[0].details.port); */
                  }

                  resolve({
                    source: { name: sourceName, appId: msg.source },
                    version: '1.2',
                  });
                }
              } else if (
                r[0].type === 'directory' &&
                r[0].details.directoryData
              ) {
                const start_url = r[0].details.directoryData.start_url;
                const pending = true;

                //let win = window.open(start_url,"_blank");
                const workspace = getRuntime().createWorkspace();

                const view = workspace.createView(start_url, {
                  directoryData: r[0].details.directoryData,
                });
                //view.directoryData = r[0].details.directoryData;
                //set pending intent for the view..
                if (pending) {
                  view.setPendingIntent(
                    intent,
                    (msg.data && msg.data.context) || undefined,
                    msg.source,
                  );
                }

                resolve({
                  source: { name: sourceName, appId: msg.source },
                  version: '1.2',
                });

                //send the context - if the default start_url was used...
                //get the window/tab...
                // resolve({result:true});
              }
            } else {
              //show resolver UI
              // Send a message to the active tab
              //sort results alphabetically, with directory entries first (before window entries)
              const getTitle = (app: FDC3App) => {
                const view = app.details.instanceId
                  ? runtime.getViews().get(app.details.instanceId)
                  : null;
                const directory = app.details.directoryData
                  ? app.details.directoryData
                  : null;
                return directory
                  ? directory.title
                  : view &&
                    view.content.webContents &&
                    view.content.webContents.hostWebContents
                  ? view.content.webContents.hostWebContents.getTitle()
                  : 'Untitled';
              };
              r.sort((a, b) => {
                //let aTitle = a.details.directoryData ? a.details.directoryData.title : a.details.view.content.webContents.getURL();
                // let bTitle = b.details.directoryData ? b.details.directoryData.title : b.details.view.content.webContents.getURL();
                if (a.details) {
                  a.details.title = getTitle(a);
                }
                if (b.details) {
                  b.details.title = getTitle(b);
                }

                if (
                  a.details &&
                  a.details.title &&
                  b.details &&
                  b.details.title &&
                  a.details.title < b.details.title
                ) {
                  return -1;
                }
                if (
                  a.details &&
                  a.details.title &&
                  b.details &&
                  b.details.title &&
                  a.details.title > b.details.title
                ) {
                  return 1;
                } else {
                  return 0;
                }
              });

              const eventId = `resolveIntent-${Date.now()}`;

              //set a handler for resolving the intent (when end user selects a destination)
              ipcMain.on(eventId, async (event, args) => {
                const r: IntentResolution = await resolveIntent(args);
                resolve(r);
              });

              //launch window with resolver UI
              // console.log('resolve intent - options', r);
              const sourceView = getRuntime().getView(msg.source);
              if (sourceView) {
                getRuntime().openResolver(
                  {
                    intent: intent,
                    context: (msg.data && msg.data.context) || undefined,
                  },
                  sourceView,
                  r,
                );
              }
            }
          } else {
            //show message indicating no handler for the intent...
            reject('no apps found for intent');
          }
        });
      } else {
        reject('No intent provided');
      }
    });
  },
});

/**
 * create a heirarchy of App Instances grouped by intents
 */
const buildIntentInstanceTree = (
  data: Array<FDC3App>,
): Array<IntentInstance> => {
  const r: Array<IntentInstance> = [];

  if (data) {
    const found: Map<string, Array<FDC3App>> = new Map();
    const intents: Array<IntentMetadata> = [];
    data.forEach((item) => {
      if (item.details.directoryData && item.details.directoryData.intents) {
        item.details.directoryData.intents.forEach((intent) => {
          if (!found.has(intent.name)) {
            intents.push({
              name: intent.name,
              displayName: intent.display_name,
            });
            found.set(intent.name, [item]);
          } else {
            const intents = found.get(intent.name);
            if (intents) {
              intents.push(item);
            }
          }
        });
      }
    });

    intents.forEach((intent) => {
      const apps: Array<FDC3App> = found.get(intent.name) || [];

      const entry: IntentInstance = { intent: intent, apps: apps };

      r.push(entry);
    });
  }
  return r;
};

_listeners.push({
  name: TOPICS.FDC3_RAISE_INTENT_FOR_CONTEXT,
  handler: (runtime, msg) => {
    return new Promise((resolve, reject) => {
      console.log('raiseIntentForContext', msg);

      const sourceView = runtime.getView(msg.source);
      const sourceName =
        sourceView && sourceView.directoryData
          ? sourceView.directoryData.name
          : 'unknown';

      const raiseIntentForContext = async () => {
        const r: Array<FDC3App> = [];

        //handle the resolver UI closing
        /* port.onMessage.addListener(async (msg : FDC3Message) => {
            if (msg.topic === "resolver-close"){
                resolve(null);
            }
        });*/

        //decorate the message with source
        //msg.source = utils.id(port);

        //add dynamic listeners from connected views
        /**
         * rather than looking for intent listeners and mathing on intent
         * loop through active intent listeners and match on context
         * this returns a map of intents and apps (with matching context listeners)
         */
        const context =
          msg.data && msg.data.context && msg.data.context.type
            ? msg.data.context.type
            : '';

        const intentListeners = runtime.getIntentListenersByContext(context);

        if (intentListeners) {
          // let keys = Object.keys(intentListeners);
          intentListeners.forEach((listeners: Array<View>) => {
            //look up the details of the window and directory metadata in the "connected" store
            listeners.forEach((view: View) => {
              // const connect : FDC3AppDetail= utils.getConnected(listener.appId);
              //connect.intent = intent;
              //decorate with the intent

              //de-dupe
              if (
                !r.find((item) => {
                  return (
                    item.details.instanceId &&
                    item.details.instanceId === view.id
                  );
                })
              ) {
                const title = view.getTitle();
                const details: FDC3AppDetail = {
                  instanceId: view.id,
                  title: title,
                  directoryData: view.directoryData,
                };
                r.push({ type: 'window', details: details });
              }
            });
          });
        }

        /**
         * To Do: Support additional AppMetadata searching (other than name)
         */
        const target: TargetApp | undefined =
          (msg.data && msg.data.target) || undefined;
        const name: string = target
          ? typeof target === 'string'
            ? target
            : (target as AppMetadata).name
          : '';
        const directoryUrl = await utils.getDirectoryUrl();

        const _r = await fetch(
          `${directoryUrl}/apps/search?context=${context}&name=${name}`,
        );
        if (_r) {
          let data = null;
          try {
            data = await _r.json();
          } catch (err) {
            console.log('error parsing json', err);
          }

          if (data) {
            data.forEach((entry: DirectoryApp) => {
              r.push({ type: 'directory', details: { directoryData: entry } });
            });
          }
        }

        if (r.length > 0) {
          if (r.length === 1) {
            //if there is only one result, use that
            //if it is a window, post a message directly to it
            //if it is a directory entry resolve the destination for the intent and launch it
            //dedupe window and directory items
            if (r[0].type === 'window' && r[0].details.instanceId) {
              const view = runtime.getView(r[0].details.instanceId);
              if (view) {
                view.content.webContents.send(TOPICS.FDC3_INTENT, {
                  topic: 'intent',
                  data: msg.data,
                  source: msg.source,
                });

                resolve({ source: msg.source, version: '1.2' });
              } else {
                reject('View could not be found');
              }
            } else if (
              r[0].type === 'directory' &&
              r[0].details.directoryData
            ) {
              const start_url = r[0].details.directoryData.start_url;
              const pending = true;

              //let win = window.open(start_url,"_blank");
              const workspace = getRuntime().createWorkspace();

              const view = workspace.createView(start_url, {
                directoryData: r[0].details.directoryData,
              });
              //view.directoryData = r[0].details.directoryData;
              //set pending intent for the view..
              const intent = msg.data && msg.data.intent;
              if (pending && intent) {
                view.setPendingIntent(
                  intent,
                  (msg.data && msg.data.context) || undefined,
                  msg.source,
                );
              }

              resolve({
                source: { name: sourceName, appId: msg.source },
                version: '1.2',
              });
            }
          } else {
            //show resolver UI
            // Send a message to the active tab
            //sort results alphabetically, with directory entries first (before window entries)
            const getTitle = (app: FDC3App) => {
              const view = app.details.instanceId
                ? runtime.getViews().get(app.details.instanceId)
                : null;
              const directory = app.details.directoryData
                ? app.details.directoryData
                : null;
              return directory
                ? directory.title
                : view &&
                  view.content.webContents &&
                  view.content.webContents.hostWebContents
                ? view.content.webContents.hostWebContents.getTitle()
                : 'Untitled';
            };
            r.sort((a, b) => {
              //let aTitle = a.details.directoryData ? a.details.directoryData.title : a.details.view.content.webContents.getURL();
              // let bTitle = b.details.directoryData ? b.details.directoryData.title : b.details.view.content.webContents.getURL();
              if (a.details) {
                a.details.title = getTitle(a);
              }
              if (b.details) {
                b.details.title = getTitle(b);
              }

              if (
                a.details &&
                a.details.title &&
                b.details &&
                b.details.title &&
                a.details.title < b.details.title
              ) {
                return -1;
              }
              if (
                a.details &&
                a.details.title &&
                b.details &&
                b.details.title &&
                a.details.title > b.details.title
              ) {
                return 1;
              } else {
                return 0;
              }
            });

            const eventId = `resolveIntent-${Date.now()}`;

            //set a handler for resolving the intent (when end user selects a destination)
            ipcMain.on(eventId, async (event, args) => {
              const r = await resolveIntent(args);
              resolve(r);
            });

            //launch window with resolver UI
            console.log('resolve intent - options', r);
            const sourceView = getRuntime().getView(msg.source);
            if (sourceView) {
              try {
                getRuntime().openResolver(
                  { context: (msg.data && msg.data.context) || undefined },
                  sourceView,
                  buildIntentInstanceTree(r),
                );
              } catch (err) {
                console.log('error opening resolver', err);
              }
            }
          }
        } else {
          //show message indicating no handler for the intent...
          reject('no apps found for intent');
        }
      };
      raiseIntentForContext();
    });
  },
});

export const listeners = _listeners;
