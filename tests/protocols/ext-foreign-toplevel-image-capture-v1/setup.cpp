// Copyright (C) 2026 UnionTech Software Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0 OR LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only
#include "ext-foreign-toplevel-image-capture-v1.h"
#include "server-bridge.h"
#include "seat/helper.h"
#include "surface/surfacewrapper.h"
#include "core/rootsurfacecontainer.h"
#include "core/shellhandler.h"

#include <wbackend.h>
#include <woutputrenderwindow.h>
#include <wsurfaceitem.h>

namespace {
SurfaceWrapper *g_wrapper = nullptr;
}

void protocol_test_setup(Helper *helper)
{
    add_headless_output(helper->backend(), false);
    QObject::connect(helper->shellHandler(),
                     &ShellHandler::surfaceWrapperAdded,
                     helper,
                     [helper](SurfaceWrapper *wrapper) {
                         if (wrapper->type() != SurfaceWrapper::Type::XdgToplevel)
                             return;
                         // Deterministic geometry: no open/resize animations,
                         // so screencopy positions can be compared exactly.
                         wrapper->disableWindowAnimation();
                         g_wrapper = wrapper;
                     });
}

void ext_capture_query_state(void *data)
{
    auto *state = static_cast<ext_capture_state *>(data);
    auto *helper = Helper::instance();
    state->output_ready = helper->rootSurfaceContainer()->outputs().isEmpty() ? 0 : 1;
    state->wrapper_ready = g_wrapper ? 1 : 0;
    if (!g_wrapper)
        return;

    state->wrapper_visible = g_wrapper->isVisible() ? 1 : 0;
    state->surface_item_visible = g_wrapper->surfaceItem()
        && g_wrapper->surfaceItem()->isVisible() ? 1 : 0;

    auto *content = g_wrapper->surfaceItem()
        ? g_wrapper->surfaceItem()->findItemContent() : nullptr;
    state->content_visible = content && content->isVisible() ? 1 : 0;
    const auto paintOrder = WOutputRenderWindow::paintOrderItemList(
        helper->window()->contentItem(), [](QQuickItem *) { return true; });
    state->content_in_paint_order = content && paintOrder.contains(content) ? 1 : 0;

    // The capture source renders the surface-item subtree (title bar +
    // client content + subsurfaces), which excludes the shadow: the shadow
    // lives in the wrapper-level decoration item, a sibling of the item.
    auto *surfaceItem = g_wrapper->surfaceItem();
    const QRectF bounds = surfaceItem ? surfaceItem->boundingRect()
                                      : g_wrapper->boundingRect();
    state->wrapper_width = qRound(bounds.width());
    state->wrapper_height = qRound(bounds.height());
    // Position of the window on the output (for the main-render checks).
    const QPointF scenePos = g_wrapper->mapToScene(QPointF(0, 0));
    state->wrapper_x = qRound(scenePos.x());
    state->wrapper_y = qRound(scenePos.y());
    if (surfaceItem) {
        // The client content sits below the title bar inside the capture:
        // report its offset relative to the capture origin.
        const QPointF itemOrigin = surfaceItem->mapFromItem(content, QPointF(0, 0));
        const QPointF offset = itemOrigin - bounds.topLeft();
        state->content_x = qRound(offset.x());
        state->content_y = qRound(offset.y());
        state->titlebar_height = state->content_y;
    }
}

void ext_capture_force_render(void *data)
{
    Q_UNUSED(data);
    auto *helper = Helper::instance();
    // Render every output, not just the primary: the captured window may sit
    // on any output in a multi-output setup.
    helper->window()->render();
}
